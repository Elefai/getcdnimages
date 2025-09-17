# Changelog

All notable changes to this project will be documented in this file.

## 1.1 – 2025-09-17

Added
- Structured request/response logs (JSON), incluindo duração e bytes.
- Headers padrão de navegador: `Accept` focado em imagens e `User-Agent` moderno.
- Sniff de tipo (JPEG/PNG/WEBP/GIF) quando o upstream retorna `text/plain`.

Changed
- Documentação: objetivo da API, exemplos genéricos, seção de logs.

Images
- GHCR: `ghcr.io/elefai/getcdnimages:1.1`, `:v1.1`, `:latest`.

## 1.0 – 2025-09-17

Initial
- API `/image` (GET/POST) para servir imagens públicas via CDN com headers de navegador.
- CLI `cdn-dl` para downloads em lote.
- Dockerfile + YAML de stack para Docker Swarm.

Images
- GHCR: `ghcr.io/elefai/getcdnimages:1.0`, `:v1.0`.
