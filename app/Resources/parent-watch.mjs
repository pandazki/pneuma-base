// Loaded with --import into the server the app starts. The app holds the other end of this
// process's standard input; when the app ends, however it ends, the pipe closes and the server goes too.
process.stdin.on('end', () => process.exit(0))
process.stdin.on('error', () => process.exit(0))
process.stdin.resume()
