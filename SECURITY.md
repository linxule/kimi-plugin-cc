# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities through [GitHub private vulnerability reporting](https://github.com/linxule/kimi-plugin-cc/security/advisories/new) or by emailing the repository owner directly.

Do not open a public issue for security vulnerabilities.

## Security-critical components

The rescue approval allowlist in `runtime/rescue-approval.ts` is a security-critical component. It controls which file-edit and shell commands the plugin will auto-approve when Kimi requests them during a rescue session. Changes to allowlist logic should be reviewed carefully.
