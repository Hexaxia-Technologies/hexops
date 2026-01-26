'use client';

import { useEffect, useRef, useState } from 'react';

interface ShellPanelProps {
  cwd: string;
  label: string;
}

// Types for xterm
type TerminalType = InstanceType<typeof import('@xterm/xterm').Terminal>;
type FitAddonType = InstanceType<typeof import('@xterm/addon-fit').FitAddon>;

export function ShellPanel({ cwd, label }: ShellPanelProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstanceRef = useRef<TerminalType | null>(null);
  const fitAddonRef = useRef<FitAddonType | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [isReady, setIsReady] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0);

  // Debug: Track mount/unmount
  useEffect(() => {
    console.log('[ShellPanel] Component mounted with cwd:', cwd);
    return () => {
      console.log('[ShellPanel] Component unmounting');
    };
  }, [cwd]);

  // Initialize terminal
  useEffect(() => {
    let mounted = true;
    let ws: WebSocket | null = null;

    console.log('[ShellPanel] Init effect running, reconnectKey:', reconnectKey);

    async function init() {
      if (!terminalRef.current) return;

      try {
        // Dynamically import xterm
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
        ]);

        // Load CSS if not already loaded
        if (!document.getElementById('xterm-css')) {
          const link = document.createElement('link');
          link.id = 'xterm-css';
          link.rel = 'stylesheet';
          link.href = '/xterm.css';
          document.head.appendChild(link);
        }

        if (!mounted || !terminalRef.current) return;

        const terminal = new Terminal({
          cursorBlink: true,
          fontSize: 13,
          fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
          theme: {
            background: '#09090b',
            foreground: '#fafafa',
            cursor: '#a855f7',
            cursorAccent: '#09090b',
            selectionBackground: '#3f3f46',
            black: '#27272a',
            red: '#f87171',
            green: '#4ade80',
            yellow: '#facc15',
            blue: '#60a5fa',
            magenta: '#c084fc',
            cyan: '#22d3ee',
            white: '#fafafa',
            brightBlack: '#52525b',
            brightRed: '#fca5a5',
            brightGreen: '#86efac',
            brightYellow: '#fde047',
            brightBlue: '#93c5fd',
            brightMagenta: '#d8b4fe',
            brightCyan: '#67e8f9',
            brightWhite: '#ffffff',
          },
        });

        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(terminalRef.current);

        // Small delay to ensure container is rendered
        setTimeout(() => {
          if (mounted) {
            fitAddon.fit();
          }
        }, 50);

        terminalInstanceRef.current = terminal;
        fitAddonRef.current = fitAddon;

        // Connect WebSocket
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/api/shell/ws?cwd=${encodeURIComponent(cwd)}`;

        ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (!mounted) return;
          setStatus('connected');
          setIsReady(true);
          ws?.send(JSON.stringify({
            type: 'resize',
            cols: terminal.cols,
            rows: terminal.rows,
          }));
        };

        ws.onmessage = (event) => {
          if (!mounted) return;
          try {
            const msg = JSON.parse(event.data);
            switch (msg.type) {
              case 'output':
                terminal.write(msg.data);
                break;
              case 'ready':
                break;
              case 'exit':
                terminal.write('\r\n\x1b[33m[Shell exited]\x1b[0m\r\n');
                setStatus('disconnected');
                break;
            }
          } catch {
            terminal.write(event.data);
          }
        };

        ws.onclose = () => {
          if (mounted) setStatus('disconnected');
        };

        ws.onerror = () => {
          if (mounted) setStatus('disconnected');
        };

        // Send input to server
        terminal.onData((data) => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', data }));
          }
        });
      } catch (error) {
        console.error('Shell initialization error:', error);
        if (mounted) setStatus('disconnected');
      }
    }

    init();

    return () => {
      mounted = false;
      ws?.close();
      wsRef.current = null;
      terminalInstanceRef.current?.dispose();
      terminalInstanceRef.current = null;
    };
  }, [cwd, reconnectKey]);

  // Handle resize
  useEffect(() => {
    if (!isReady) return;

    const handleResize = () => {
      const fitAddon = fitAddonRef.current;
      const terminal = terminalInstanceRef.current;
      const ws = wsRef.current;

      if (fitAddon && terminal) {
        fitAddon.fit();
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'resize',
            cols: terminal.cols,
            rows: terminal.rows,
          }));
        }
      }
    };

    const timeoutId = setTimeout(handleResize, 100);
    window.addEventListener('resize', handleResize);

    const observer = new ResizeObserver(handleResize);
    if (terminalRef.current) {
      observer.observe(terminalRef.current);
    }

    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener('resize', handleResize);
      observer.disconnect();
    };
  }, [isReady]);

  const handleReconnect = () => {
    // Close existing connections
    wsRef.current?.close();
    wsRef.current = null;
    terminalInstanceRef.current?.dispose();
    terminalInstanceRef.current = null;
    // Reset state and trigger re-initialization
    setStatus('connecting');
    setIsReady(false);
    setReconnectKey(k => k + 1);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800/50 flex-shrink-0 bg-zinc-900/30">
        <div className="text-xs text-zinc-500">
          <span className="text-zinc-300">{label}</span>
          <span className="mx-2">—</span>
          <span className="font-mono text-zinc-600 truncate max-w-[200px] inline-block align-bottom">
            {cwd}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${
            status === 'connected' ? 'bg-green-500' :
            status === 'connecting' ? 'bg-yellow-500 animate-pulse' :
            'bg-red-500'
          }`} />
          <span className="text-xs text-zinc-600">{status}</span>
          {status === 'disconnected' && (
            <button
              onClick={handleReconnect}
              className="text-xs text-purple-400 hover:text-purple-300"
            >
              Reconnect
            </button>
          )}
        </div>
      </div>

      {/* Terminal */}
      <div
        ref={terminalRef}
        className="flex-1 bg-[#09090b] p-2 overflow-hidden"
      />
    </div>
  );
}
