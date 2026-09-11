package dialcache

// profileCohortRamp binds a fixed uint32 sample and BELOW/AT/ABOVE choice to
// the public percentage configuration. It never calls the production hash.
func profileCohortRamp(sample uint64, relation int64) float64 {
	if sample < 1 || sample >= 0xffffffff || relation < 0 || relation > 2 {
		panic("invalid fixed cohort boundary input")
	}
	return float64(int64(sample)+relation-1) / 4294967296 * 100
}
