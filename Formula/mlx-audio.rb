class MlxAudio < Formula
  include Language::Python::Virtualenv

  desc "Speech-to-text, text-to-speech and audio separation server for Apple silicon"
  homepage "https://github.com/Blaizzy/mlx-audio"
  url "https://files.pythonhosted.org/packages/cb/be/1b47eb8f6d8da84ea3f5a1e5257195ba11f1e90af22754fb698393dad1f9/mlx_audio-0.6.4.tar.gz"
  sha256 "092dee1f010846cee76b164a988ad9802e45d4c79771d65d55ceb9de246fab4b"
  license "MIT"
  head "https://github.com/Blaizzy/mlx-audio.git", branch: "main"

  # MLX runs on the Apple GPU (Metal); the PyPI wheels need macOS 14+ on arm64.
  depends_on arch: :arm64
  depends_on "ffmpeg"
  depends_on macos: :sonoma
  depends_on "python@3.15"

  # spaCy English pipeline used by misaki (Kokoro's grapheme-to-phoneme step). Installed here so the
  # first text-to-speech request does not try to pip-install it into the Cellar at run time.
  resource "en_core_web_sm" do
    url "https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl",
        using: :nounzip
    sha256 "1932429db727d4bff3deed6b34cfc05df17794f4a52eeb26cf8928f7c1a0fb85"
  end

  def install
    # Isolated venv: everything comes from PyPI, nothing from the brewed Python's global site-packages.
    virtualenv_create(libexec, "python3.15", system_site_packages: false)
    # Homebrew's venv has no pip of its own; drive the brewed Python's pip with --python= as Homebrew itself does.
    pip = [formula_opt_bin("python@3.15")/"python3.15", "-m", "pip", "--python=#{libexec}/bin/python",
           "install", "--no-cache-dir", "--prefer-binary"]
    # Wheels from PyPI: mlx + mlx-metal give the Apple GPU. [server] = the OpenAI-style API,
    # [stt]/[tts] = Whisper/Parakeet and Kokoro/Chatterbox/Qwen3-TTS extras.
    # misaki is Kokoro's English text front end. Its [en] extra also lists spacy-curated-transformers, which only
    # serves misaki's transformer tagger (trf=True, unused by mlx-audio) and needs thinc 9 while spaCy 3.8 needs
    # thinc 8, so the remaining [en] dependencies are listed by hand. misaki imports torch at module level.
    system(*pip, "#{buildpath}[server,stt,tts]",
           "misaki", "espeakng-loader", "num2words", "phonemizer-fork", "spacy", "torch")
    resource("en_core_web_sm").stage { system(*pip, "--no-deps", Dir["*.whl"].first) }
    bin.install_symlink Dir[libexec/"bin/mlx_audio.*"]
  end

  def caveats
    <<~EOS
      Models are downloaded on first use into ~/.cache/huggingface (set HF_HOME to move them).

      Start the API server (Sound Lab's "native" mode finds this binary and can start it for you):
        mlx_audio.server --host 127.0.0.1 --port 8000
      Or keep it running in the background:
        brew services start mlx-audio

      The web UI is a separate package: brew install mlx-audio-studio
    EOS
  end

  service do
    run [opt_bin/"mlx_audio.server", "--host", "127.0.0.1", "--port", "8000", "--log-dir", var/"log/mlx-audio"]
    keep_alive true
    working_dir var
    log_path var/"log/mlx-audio.log"
    error_log_path var/"log/mlx-audio.log"
    environment_variables PATH: std_service_path_env
  end

  test do
    system libexec/"bin/python", "-m", "pip", "check"
    system libexec/"bin/python", "-c", "import mlx.core as mx, mlx_audio.server; print(mx.default_device())"

    port = free_port
    pid = spawn bin/"mlx_audio.server", "--host", "127.0.0.1", "--port", port.to_s, "--log-dir", testpath/"logs"
    begin
      output = shell_output("curl --silent --retry 20 --retry-connrefused --retry-delay 1 http://127.0.0.1:#{port}/v1/models")
      assert_match "data", output
    ensure
      Process.kill "SIGTERM", pid
      Process.wait pid
    end
  end
end
