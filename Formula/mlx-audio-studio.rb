require "json"

class MlxAudioStudio < Formula
  desc "Web UI for the mlx-audio speech server (prebuilt Next.js Studio)"
  homepage "https://github.com/Blaizzy/mlx-audio"
  url "https://github.com/Blaizzy/mlx-audio/archive/refs/tags/v0.6.4.tar.gz"
  sha256 "2adfeaabec161da89afacf173dd40bd1df0ac457551ef1a23647fce947c95a20"
  license "MIT"
  head "https://github.com/Blaizzy/mlx-audio.git", branch: "main"

  depends_on "mlx-audio"
  depends_on "node"

  # The Studio's browser code bakes the API location in at build time (NEXT_PUBLIC_*). Sound Lab reads
  # studio.json to check that this build matches its configured API URL before using it.
  API_BASE = "http://localhost".freeze
  API_PORT = "8000".freeze

  def install
    ui = libexec/"ui"
    cd "mlx_audio/ui" do
      ENV["NEXT_TELEMETRY_DISABLED"] = "1"
      ENV["NEXT_PUBLIC_API_BASE_URL"] = API_BASE
      ENV["NEXT_PUBLIC_API_PORT"] = API_PORT
      system "npm", "install", *std_npm_args(prefix: false), "--no-audit", "--no-fund"
      # Upstream only ever runs `next dev`. Its sources fail ESLint and one TypeScript check
      # (components/audio-orb.tsx uses createMediaStreamSource on a BaseAudioContext), which `next build` enforces.
      inreplace "next.config.mjs", 'output: "standalone",',
                'output: "standalone",' + "\n" + "  typescript: { ignoreBuildErrors: true },"
      system "node_modules/.bin/next", "build", "--no-lint"
      # next.config.mjs sets output "standalone": .next/standalone holds server.js plus the node_modules it needs.
      # Static assets and public files are copied in by hand, as the Next.js docs require.
      standalone = Pathname.new(".next/standalone")
      (standalone/".next/static").install Dir[".next/static/*"]
      (standalone/"public").install Dir["public/*"] if File.directory?("public")
      ui.install Dir[standalone/"{*,.next}"]
    end

    manifest = { name: "mlx-audio-studio", version: version.to_s, api: "#{API_BASE}:#{API_PORT}",
                 launcher: (opt_bin/"mlx-audio-studio").to_s }
    (ui/"studio.json").write JSON.pretty_generate(manifest) + "\n"

    (bin/"mlx-audio-studio").write <<~SH
      #!/bin/bash
      # mlx-audio Studio (Next.js standalone build). The UI talks to the mlx-audio API at #{API_BASE}:#{API_PORT}.
      set -e
      port="${MLX_AUDIO_STUDIO_PORT:-3000}"
      host="${MLX_AUDIO_STUDIO_HOST:-127.0.0.1}"
      while [ $# -gt 0 ]; do
        case "$1" in
          -p|--port) port="$2"; shift 2 ;;
          -H|--host|--hostname) host="$2"; shift 2 ;;
          -h|--help) echo "usage: mlx-audio-studio [-p PORT] [-H HOST]   (defaults: 3000, 127.0.0.1)"; exit 0 ;;
          *) echo "mlx-audio-studio: unknown option: $1" >&2; exit 2 ;;
        esac
      done
      cd "#{opt_libexec}/ui"
      export PORT="$port" HOSTNAME="$host"
      exec "#{formula_opt_bin("node")}/node" server.js
    SH
  end

  def caveats
    <<~EOS
      Serve the Studio on http://127.0.0.1:3000 with:
        mlx-audio-studio            (or: brew services start mlx-audio-studio)
      It expects the API server at #{API_BASE}:#{API_PORT}:
        brew services start mlx-audio
      Sound Lab (VS Code) embeds this build when its soundLab.mlx.port is 8000.
    EOS
  end

  service do
    run [opt_bin/"mlx-audio-studio"]
    keep_alive true
    working_dir var
    log_path var/"log/mlx-audio-studio.log"
    error_log_path var/"log/mlx-audio-studio.log"
  end

  test do
    assert_equal "#{API_BASE}:#{API_PORT}", JSON.parse((libexec/"ui/studio.json").read)["api"]

    port = free_port
    pid = spawn bin/"mlx-audio-studio", "--port", port.to_s
    begin
      # "/" redirects (307) to the first page, so follow it.
      output = shell_output("curl --silent --location --retry 20 --retry-connrefused --retry-delay 1 http://127.0.0.1:#{port}/")
      assert_match "<html", output.downcase
    ensure
      Process.kill "SIGTERM", pid
      Process.wait pid
    end
  end
end
