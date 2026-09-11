import { connect, constants } from 'node:http2';
import { setTimeout as delay } from 'node:timers/promises';

const symbol = Buffer.from('shai.cmdExecutor.CmdExecutor');
// ServerReflectionRequest.file_containing_symbol is protobuf field 4.
const requestMessage = Buffer.concat([Buffer.from([0x22, symbol.length]), symbol]);
const requestFrame = Buffer.alloc(5 + requestMessage.length);
requestFrame.writeUInt32BE(requestMessage.length, 1);
requestMessage.copy(requestFrame, 5);

// Read only protobuf's wire framing. Descriptor contents remain opaque, apart
// from requiring a nonempty file name in each returned FileDescriptorProto.
function fields(bytes) {
  let offset = 0;
  const result = [];
  const integer = () => {
    let value = 0, multiplier = 1;
    for (let count = 0; count < 10 && offset < bytes.length; count++) {
      const byte = bytes[offset++];
      value += (byte & 0x7f) * multiplier;
      if (!Number.isSafeInteger(value)) throw new Error('Invalid protobuf integer');
      if (!(byte & 0x80)) return value;
      multiplier *= 128;
    }
    throw new Error('Truncated protobuf integer');
  };
  while (offset < bytes.length) {
    const tag = integer(), number = Math.floor(tag / 8), wire = tag % 8;
    if (!number) throw new Error('Invalid protobuf field');
    let value;
    if (wire === 2) {
      const length = integer();
      if (length > bytes.length - offset) throw new Error('Truncated protobuf field');
      value = bytes.subarray(offset, offset + length);
      offset += length;
    } else if (wire === 0) integer();
    else if (wire === 1 || wire === 5) offset += wire === 1 ? 8 : 4;
    else throw new Error('Unsupported protobuf wire type');
    if (offset > bytes.length) throw new Error('Truncated protobuf field');
    result.push({ number, wire, value });
  }
  return result;
}

function descriptorResponse(frame) {
  if (frame.length < 5 || frame[0] !== 0 || frame.readUInt32BE(1) !== frame.length - 5) return false;
  const response = fields(frame.subarray(5));
  if (response.some(field => field.number === 7)) return false; // Reflection error_response.
  const descriptors = response.filter(field => field.number === 4 && field.wire === 2);
  if (descriptors.length !== 1) return false;
  const files = fields(descriptors[0].value).filter(field => field.number === 1 && field.wire === 2);
  return files.length > 0 && files.every(file => file.value.length > 0 &&
    fields(file.value).some(field => field.number === 1 && field.wire === 2 && field.value.length > 0));
}

function reflect(endpoint, timeoutMs) {
  return new Promise(resolve => {
    const session = connect(`http://${endpoint}`);
    let stream, finished = false, size = 0, headers, grpcStatus;
    const chunks = [];
    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stream?.close(constants.NGHTTP2_CANCEL);
      session.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish('reflection request timed out'), timeoutMs);
    session.on('error', error => finish(error.message));
    session.on('close', () => finish('reflection connection closed'));
    session.once('connect', () => {
      if (finished) return;
      stream = session.request({ ':method': 'POST',
        ':path': '/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo',
        'content-type': 'application/grpc', te: 'trailers',
        'grpc-timeout': `${Math.max(1, Math.floor(timeoutMs))}m` });
      stream.on('error', error => finish(error.message));
      stream.on('response', value => { headers = value; grpcStatus = value['grpc-status']; });
      stream.on('trailers', value => { grpcStatus = value['grpc-status']; });
      stream.on('data', chunk => {
        size += chunk.length;
        if (size > 256 * 1024) finish('reflection response exceeds 256 KiB');
        else chunks.push(chunk);
      });
      stream.on('end', () => {
        try {
          if (headers?.[':status'] !== 200 || !/^application\/grpc(?:\+proto)?(?:;|$)/.test(headers['content-type'] ?? '')
              || grpcStatus !== '0' || !descriptorResponse(Buffer.concat(chunks))) {
            finish('reflection did not return a successful nonempty file descriptor');
          } else finish(undefined);
        } catch (error) { finish(`malformed reflection response: ${error.message}`); }
      });
      stream.on('close', () => finish('reflection stream closed before its result'));
      stream.end(requestFrame);
    });
  });
}

// A bound TCP socket is insufficient: Quint queries this reflection operation
// once before falling back to launching/downloading another solver.
export async function waitForApalache(endpoint, assertAlive, timeoutMs = 20_000) {
  if (!/^127\.0\.0\.1:[1-9]\d*$/.test(endpoint) || Number(endpoint.split(':')[1]) > 65535
      || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid Apalache readiness endpoint or timeout');
  const deadline = performance.now() + timeoutMs;
  let failure = 'no reflection response';
  while (performance.now() < deadline) {
    assertAlive();
    failure = await reflect(endpoint, Math.max(1, Math.min(1000, deadline - performance.now())));
    assertAlive();
    if (failure === undefined) return;
    await delay(Math.max(0, Math.min(50, deadline - performance.now())));
  }
  throw new Error(`Owned Apalache reflection was not ready within ${timeoutMs}ms: ${failure}`);
}
