// Docker health check (#352): healthy when the web server answers on the host loopback. Without
// the sign-in cookie it answers 401, which still proves it is up.
const port = process.env.FLYBOT_PORT || '3080'
try {
  const response = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(4000) })
  process.exit(response.status < 500 ? 0 : 1)
} catch {
  process.exit(1)
}
