// Docker health check (#352): healthy when the web server answers. Without the sign-in cookie
// it answers 401, which still proves it is up.
try {
  const response = await fetch('http://127.0.0.1:3080/', { redirect: 'manual', signal: AbortSignal.timeout(4000) })
  process.exit(response.status < 500 ? 0 : 1)
} catch {
  process.exit(1)
}
