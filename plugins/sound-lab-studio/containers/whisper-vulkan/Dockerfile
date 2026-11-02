# Sound Lab — whisper.cpp with the Vulkan backend.
# On macOS this is the one container path to the Apple GPU: run it under Podman with a libkrun machine
# (`podman machine init --provider libkrun`), which exposes Venus/Vulkan → MoltenVK → Metal as /dev/dri.
# MCP settings: runner "podman", container_gpu "dri". Docker Desktop has no GPU path on macOS (CPU fallback).
# On Linux it uses any Vulkan GPU via /dev/dri (AMD, Intel, NVIDIA).
FROM debian:trixie-slim AS build
ARG WHISPER_CPP_REF=v1.9.5
RUN apt-get update && apt-get install -y --no-install-recommends \
      git cmake build-essential ca-certificates libvulkan-dev glslc spirv-headers \
 && rm -rf /var/lib/apt/lists/*
# GGML_NATIVE=OFF: the published binary must not be tuned to the CI runner's CPU (illegal instruction elsewhere).
RUN git clone --depth 1 --branch "${WHISPER_CPP_REF}" https://github.com/ggml-org/whisper.cpp /src \
 && cmake -S /src -B /src/build -DGGML_VULKAN=ON -DGGML_NATIVE=OFF -DWHISPER_BUILD_EXAMPLES=ON -DBUILD_SHARED_LIBS=OFF -DCMAKE_BUILD_TYPE=Release \
 && cmake --build /src/build -j"$(nproc)" --target whisper-cli

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      libvulkan1 mesa-vulkan-drivers libgomp1 ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/build/bin/whisper-cli /usr/local/bin/whisper-cli
WORKDIR /work
# Models are bind-mounted by the MCP server (whispercpp_model setting).
CMD ["whisper-cli", "--help"]
