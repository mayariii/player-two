import { manager } from '$lib/server/manager';
export function GET({ request }: { request: Request }) {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (text: string) => { if (!closed) controller.enqueue(encoder.encode(text)); };
      const unsubscribe = manager.subscribe(state => send(`data: ${JSON.stringify(state)}\n\n`));
      const heartbeat = setInterval(() => send(': heartbeat\n\n'), 5000);
      cleanup = () => { if (closed) return; closed = true; unsubscribe(); clearInterval(heartbeat); request.signal.removeEventListener('abort', cleanup); };
      request.signal.addEventListener('abort', cleanup, { once: true });
      if (request.signal.aborted) cleanup();
    },
    cancel() { cleanup(); }
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } });
}
