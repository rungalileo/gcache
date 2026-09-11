// Bind Quint's uint32 numerator to the public percentage configuration.
// Fixture numerators are fixed protocol inputs, never production hash results.
export function cohortRamp(sample, relation) {
  if (!Number.isSafeInteger(sample) || sample < 1 || sample >= 0xffff_ffff
    || !Number.isInteger(relation) || relation < 0 || relation > 2) {
    throw new Error("Invalid fixed cohort boundary input");
  }
  return ((sample + relation - 1) / 0x1_0000_0000) * 100;
}
