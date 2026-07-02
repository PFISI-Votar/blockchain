import net from 'node:net';

/**
 * Waits until a TCP host:port accepts connections or the timeout elapses.
 */
export const waitForTcp = (host, port, timeoutMs = 60_000) =>
  new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const tryConnect = () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(
          new Error(
            `Timeout esperando ${host}:${port} (${timeoutMs}ms)`,
          ),
        );
        return;
      }

      const socket = net.connect({ host, port });
      socket.once('connect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        setTimeout(tryConnect, 500);
      });
    };

    tryConnect();
  });
