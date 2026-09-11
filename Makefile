.DEFAULT_GOAL := help
# A single checkout owns the corpus and completion reports. Separate CI jobs
# may run independently; parallel goals in this checkout must keep phase order.
.NOTPARALLEL:

NODE ?= node

.PHONY: help check check-ts check-go docs audit smoke formal formal-corpus formal-go fixtures-check mutations mutations-ts mutations-go integration integration-ts integration-go package-floor ci explore model-check

help check check-ts check-go docs audit smoke formal formal-corpus formal-go fixtures-check mutations mutations-ts mutations-go integration integration-ts integration-go package-floor ci explore model-check:
	$(NODE) formal/validation.mjs $@
