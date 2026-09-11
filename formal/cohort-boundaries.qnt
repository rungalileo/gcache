module cohort_boundaries {
  // W03 assigns a uint32 numerator to each canonical key and discriminator.
  // C19/C47 compare that sample strictly with the selected serving/shadow ramp.
  // Native bindings convert a numerator n to (n / 2^32) * 100 percent.
  // Hash construction has separate wire-vector evidence; this module specifies
  // the admission boundary without calling an implementation hash function.

  pure val COHORT_DENOMINATOR = 4294967296
  pure val BELOW_SAMPLE = 0
  pure val AT_SAMPLE = 1
  pure val ABOVE_SAMPLE = 2

  pure def thresholdForRelation(sample: int, relation: int): int =
    sample + relation - AT_SAMPLE

  pure def cohortAdmits(sample: int, threshold: int): bool =
    sample < threshold
}
