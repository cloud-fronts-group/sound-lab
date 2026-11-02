# Sound Lab — portable ffmpeg runner for batch jobs (runner "docker" / "podman").
# Debian trixie ships FFmpeg 7.1 with libmp3lame, libopus, libvorbis, libx264, libx265, libfdk-aac-free alternatives (aac), rubberband.
# CPU-only on macOS (Linux VM, no VideoToolbox). On Apple Silicon prefer runner "local" for hardware encoding.
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && ffmpeg -hide_banner -version | head -1
WORKDIR /work
# No ENTRYPOINT: the MCP server runs `<image> ffmpeg <args>` / `<image> ffprobe <args>`.
CMD ["ffmpeg", "-hide_banner", "-version"]
