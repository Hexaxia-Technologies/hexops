# Terminal

HexOps includes an integrated terminal for running commands without leaving the browser.

## Opening the Terminal

### From Sidebar

Click the terminal icon in the left sidebar to open a shell in the configured `projectsRoot` directory.

### From Project

Click the terminal icon on a project row or in the project detail page to open a shell in that project's directory.

## Features

### Full PTY Emulation

The terminal provides a real pseudo-terminal (PTY) with:
- Full color support
- Cursor positioning
- Line editing
- Tab completion
- History navigation

### Shell Support

Uses your system's default shell:
- Bash
- Zsh
- Or configured shell from settings

### Keyboard Shortcuts

Standard terminal shortcuts work:

| Shortcut | Action |
|----------|--------|
| `Ctrl+C` | Interrupt current process |
| `Ctrl+D` | End input / Exit shell |
| `Ctrl+L` | Clear screen |
| `Ctrl+R` | Reverse search history |
| `Tab` | Auto-complete |
| `Up/Down` | Navigate history |

## Using the Terminal

### Running Commands

Type commands as you would in any terminal:

```bash
# Navigate directories
cd my-project

# Run scripts
pnpm install
pnpm dev

# Git operations
git status
git pull

# System commands
ls -la
```

### Multiple Sessions

Each terminal instance is a separate session. Opening the terminal from different projects creates new sessions in those directories.

## Connection Status

The terminal shows connection status:

- **Connected** - Green indicator, terminal is ready
- **Connecting** - Yellow indicator, establishing connection
- **Disconnected** - Red indicator, connection lost

### Reconnecting

If the connection drops:
1. A "Reconnect" button appears
2. Click to establish a new connection
3. Previous session state is lost

## Technical Details

### Architecture

The terminal uses:
- **xterm.js** - Terminal emulator in the browser
- **node-pty** - Native PTY spawning on the server
- **WebSocket** - Real-time bidirectional communication

### WebSocket Endpoint

The terminal connects to `/api/shell/ws` via WebSocket.

### Security

- Terminal only accessible locally
- No remote access by default
- Commands run with your user permissions

## Troubleshooting

### Terminal Not Loading

If the terminal shows a blank screen:
1. Check browser console for errors
2. Verify WebSocket connection
3. Restart HexOps server

### node-pty Errors

If terminal fails with native module errors:

```bash
# Rebuild native modules
pnpm rebuild node-pty

# On Linux, ensure build tools
sudo apt install build-essential

# On macOS, ensure Xcode tools
xcode-select --install
```

### Font Issues

If characters appear incorrectly:
- The terminal uses a monospace font
- Ensure your browser supports the font
- Check for font rendering settings

## Limitations

- Single terminal per panel (no tabs yet)
- Session lost on page reload
- No persistent sessions across restarts
