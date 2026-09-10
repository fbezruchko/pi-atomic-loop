# pi.dev Gallery Assets

This package includes static gallery assets for https://pi.dev/packages:

- `assets/pi-loop-mode-demo.mp4` — 8 second MP4 preview video (1280×720, H.264/yuv420p, faststart)
- `assets/pi-loop-mode-preview.png` — fallback poster image (1280×720 PNG)

The `package.json` `pi` manifest references the assets through unpkg URLs:

```json
"pi": {
  "extensions": ["extensions"],
  "skills": ["skills"],
  "prompts": ["prompts"],
  "video": "https://unpkg.com/pi-loop-mode@2.5.4/assets/pi-loop-mode-demo.mp4",
  "image": "https://unpkg.com/pi-loop-mode@2.5.4/assets/pi-loop-mode-preview.png"
}
```

Why unpkg? pi.dev requires public `video`/`image` URLs. Because the assets are shipped inside the npm tarball, unpkg can serve them without separate hosting.

## Updating assets

1. Replace the files in `assets/`.
2. Bump the package version in `package.json`.
3. Update the unpkg URLs in `package.json` to the same version.
4. Run:

```bash
npm pack --dry-run
npm publish
```

The pi.dev package gallery indexes npm packages tagged with the `pi-package` keyword automatically. No manual submit step is required.
