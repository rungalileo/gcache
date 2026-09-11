import { basename, resolve } from 'node:path';
import { root } from './execution.mjs';

const protocolTitles = {
  keyVectors: 'constructs ', invalidKeyVectors: 'rejects invalid identity: ',
  normalizeArgsVectors: 'normalizes args: ', frameVectors: 'encodes frame: ',
  trackedDecodeVectors: 'decodes tracked frame: ', untrackedDecodeVectors: 'decodes untracked frame: ',
  invalidTimestampVectors: 'rejects timestamp: ', envelopeVectors: 'handles payload envelope: ',
  compressedDecodeVectors: 'decodes compressed payload: ', compressionWriteVectors: 'selects compression representation: ',
  durationVectors: 'bounds physical duration: ', rampVectors: 'assigns deterministic cohort: ',
};
export const protocolGoRoots = {
  keyVectors: 'TestProtocolKeys', invalidKeyVectors: 'TestProtocolKeys', frameVectors: 'TestProtocolFrames',
  trackedDecodeVectors: 'TestProtocolDecoders/trackedDecodeVectors', untrackedDecodeVectors: 'TestProtocolDecoders/untrackedDecodeVectors',
  rampVectors: 'TestProtocolCohorts',
  normalizeArgsVectors: 'TestProtocolRemainingVectors', invalidTimestampVectors: 'TestProtocolRemainingVectors',
  envelopeVectors: 'TestProtocolRemainingVectors', compressedDecodeVectors: 'TestProtocolRemainingVectors',
  compressionWriteVectors: 'TestProtocolRemainingVectors', durationVectors: 'TestProtocolRemainingVectors',
};
const goName = name => {
  if (!name || /[^\x20-\x7e]/.test(name) || name.includes('#')) throw new Error('Unsupported Go fixture test name');
  return name.replaceAll(' ', '_');
};
const profileFile = profile => profile === 'core' ? 'formal-conformance.test.ts' : profile === 'effects'
  ? 'formal-effects.test.ts' : profile === 'local-clock' ? 'formal-local-clock.test.ts' : 'formal-features.test.ts';
const profileSuite = profile => profile === 'core' ? 'Quint model-based conformance' : profile === 'effects'
  ? 'generated pending-effect conformance' : `generated ${profile} conformance`;

export function nativeBinding(entry, language, workspace = root) {
  if (language === 'go') {
    if (entry.category === 'sampled' || entry.category === 'regression') {
      const prefix = entry.profile === 'core' ? 'TestCoreConformance' : entry.profile === 'effects' ? 'TestEffectsConformance'
        : entry.profile === 'local-clock' ? 'TestLocalClockConformance' : `TestFeatureConformance/${entry.profile}`;
      return `${prefix}/${basename(entry.path)}`;
    }
    if (entry.category === 'scenario') return `TestBehaviorConformance/${goName(entry.feature)}/${goName(entry.name)}`;
    if (entry.category === 'protocol') return `${protocolGoRoots[entry.group] ?? 'TestProtocolRemainingVectors'}/${goName(entry.name)}`;
    return `TestGeneratedWitnessEvidence/${entry.profile}`;
  }
  if (language !== 'typescript') throw new Error('Native report adapter is only supplied for TypeScript and Go');
  if (entry.category === 'sampled' || entry.category === 'regression') return [profileFile(entry.profile),
    `${profileSuite(entry.profile)} replays ${resolve(workspace, entry.path)}`];
  if (entry.category === 'scenario') return ['formal-behavior.test.ts', `portable behavioral scenarios ${entry.feature}: ${entry.name}`];
  if (entry.category === 'protocol') {
    if (!protocolTitles[entry.group]) throw new Error(`Missing TypeScript protocol binding: ${entry.group}`);
    return ['formal-protocol-vectors.test.ts', `formal protocol conformance vectors ${protocolTitles[entry.group]}${entry.name}`];
  }
  const title = entry.profile === 'effects' ? 'covers every action and the required race witnesses' : entry.profile === 'local-clock'
    ? 'reaches fractional expiry and shared instance grid' : 'reaches every action and required outcome or race';
  return [profileFile(entry.profile), `${profileSuite(entry.profile)} ${title}`];
}
