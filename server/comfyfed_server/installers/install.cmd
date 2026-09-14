@powershell -NoProfile -ExecutionPolicy Bypass -Command "irm '{{PLATFORM_URL}}/install.ps1{{TOKEN_QUERY}}' | iex"
