import { createConnection } from 'net';

export function checkPort(port: number, timeout = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: 'localhost' });

    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeout);

    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

export async function checkPorts(ports: number[]): Promise<Map<number, boolean>> {
  const results = new Map<number, boolean>();

  await Promise.all(
    ports.map(async (port) => {
      const isRunning = await checkPort(port);
      results.set(port, isRunning);
    })
  );

  return results;
}

export async function getPortStatus(port: number): Promise<'running' | 'stopped'> {
  const isRunning = await checkPort(port);
  return isRunning ? 'running' : 'stopped';
}
