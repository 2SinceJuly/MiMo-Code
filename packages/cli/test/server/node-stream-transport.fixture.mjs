import { Hono } from "hono"
import { stream } from "hono/streaming"
import { createAdaptorServer } from "@hono/node-server"

const chunked = process.argv[2] === "chunked"
const app = new Hono().post("/message/:phase", async (c) => {
  c.status(200)
  c.header("Content-Type", "application/json")
  if (chunked) c.header("Transfer-Encoding", "chunked")
  const response = stream(c, async (api) => {
    if (c.req.param("phase") === "late") {
      await api.write(" ")
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    await api.pipe(new ReadableStream({
      start(controller) { controller.error(new Error("prompt outcome unavailable")) },
    }))
  })
  // Instance middleware can yield before the adapter begins reading a response.
  // An early stream failure must remain an error even when it is already ready.
  if (c.req.param("phase") === "early") await new Promise((resolve) => setTimeout(resolve, 10))
  return response
})
// Exercise standard native Response objects, which can coexist with adapters'
// optimized Response class in Node/Electron; pre-read optimization handles these.
const server = createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false })
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
try {
  const { port } = server.address()
  const outcomes = []
  for (const phase of ["early", "late"]) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/message/${phase}`, { method: "POST" })
      try {
        const body = await response.text()
        outcomes.push({ phase, status: response.status, body, headers: Object.fromEntries(response.headers) })
      } catch (error) {
        outcomes.push({ phase, status: response.status, readError: error.name, headers: Object.fromEntries(response.headers) })
      }
    } catch (error) {
      outcomes.push({ phase, fetchError: error.name })
    }
  }
  process.stdout.write(JSON.stringify(outcomes))
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
