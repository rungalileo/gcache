package dialcache

import "log"

// The default follows the TypeScript console logger. Applications may provide
// their own Logger; all its callbacks are isolated from cache/source results.
type defaultLogger struct{}

func (defaultLogger) Debug(message string, details any) { log.Print(message, ": ", details) }
func (defaultLogger) Warn(message string, details any)  { log.Print(message, ": ", details) }
func (defaultLogger) Error(message string, details any) { log.Print(message, ": ", details) }
