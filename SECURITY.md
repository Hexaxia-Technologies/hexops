# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.9.x   | :white_check_mark: |
| < 0.9   | :x:                |

## Reporting a Vulnerability

We take security seriously at Hexaxia Technologies.

If you discover a security vulnerability in HexOps, please report it responsibly:

1. **Do not** open a public GitHub issue for security vulnerabilities
2. Use [GitHub Security Advisories](https://github.com/Hexaxia-Technologies/hexops/security/advisories/new) to report privately
3. Include as much detail as possible:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

## What to Expect

- We will acknowledge receipt within 48 hours
- We will provide an initial assessment within 7 days
- We will work with you to understand and resolve the issue
- Once fixed, we will publicly acknowledge your contribution (unless you prefer to remain anonymous)

## Scope

HexOps runs locally on your machine. Security considerations include:

- **Local file access**: HexOps reads/writes to configured project directories
- **Shell execution**: The integrated terminal runs commands with your user permissions
- **Network requests**: Limited to configured integrations (Vercel API, package registries)

Since HexOps is a local development tool (not a web service), typical web vulnerabilities (XSS, CSRF, etc.) have limited impact. However, we still want to know about any issues that could compromise a developer's local environment.

## Security Best Practices

When using HexOps:

- Keep your `hexops.config.json` private (it's in `.gitignore` by default)
- Don't expose HexOps to external networks
- Review package updates before applying them in bulk
