# 0.1.3 更新短片旁白

使用 Windows System.Speech 的 `Microsoft Huihui Desktop` 声线离线生成。12 句旁白分别设置 SSML 语速和语调，拼接后按真实语音长度生成字幕时间轴。

## 已验收结果

- PCM s16le、48 kHz、双声道，时长 **43.190 秒**。
- FFmpeg 实测 **-17.2 LUFS、-1.5 dBTP**；采样峰值 -1.49 dBFS，无满幅样本。
- 0.2 秒开场留白，约 0.7 秒结尾留白；句间停顿 0.13–0.24 秒。
- 在独立目录完整重建后，WAV 的 SHA-256 与交付音频完全一致。

## 文件职责

| 文件 | 用途 |
| --- | --- |
| `synth_sapi.ps1` | 调用已安装的中文声线，按句生成 48 kHz 单声道语音；失败明确报错 |
| `voiceover_pipeline.py` | 内置口播与语调参数，拼接语音、校准并实测响度、生成交付文件 |
| `voiceover.wav` | 供视频剪辑使用的最终旁白生成物 |
| `narration.json` | 实际逐句时间轴和声音参数，作为画面与字幕对齐依据 |
| `captions.srt` | UTF-8 标准 SRT，使用逗号分隔毫秒 |

## 重新生成

需要 Windows、可用的上述中文声线、PATH 中的 PowerShell 7 (`pwsh`)，以及安装 `numpy`、`imageio_ffmpeg` 的 Python。路径均相对脚本自身解析，不需要网络语音服务。

本机示例，从仓库根目录运行：

```powershell
& 'D:/conda/py310/python.exe' promo/update-013/audio/voiceover_pipeline.py
```

该命令会重建 `build/` 中间文件，并覆盖本目录的 WAV、JSON 和 SRT。视频只改镜头时，可直接复用已生成的旁白。音频生成物不进入 Git；可从发布页的视频素材包获取，或按上述命令重建。

口播将项目名读作“DSH 外包”，版本读作“零点一点三”；字幕保留 `dsh-waibao 0.1.3` 拼写。移除了不可用的在线合成路径和降级分支，最终脚本仅使用本地 SSML。
