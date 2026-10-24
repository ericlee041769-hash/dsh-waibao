param(
  [Parameter(Mandatory=$true)][string]$Spec,
  [Parameter(Mandatory=$true)][string]$OutDir
)
# Offline Chinese narration renderer for the dsh-waibao 0.1.3 update film.
# Renders every sentence of $Spec as a separate 48 kHz 16-bit mono PCM wav using
# Windows System.Speech (SAPI 5) SSML. No network, no fallback: a failure stops.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

if (-not (Test-Path -LiteralPath $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

$narrationSpec = Get-Content -Raw -Encoding UTF8 -LiteralPath $Spec | ConvertFrom-Json

$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  48000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$installed = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name })
if ($installed -notcontains $narrationSpec.voice) {
  throw "Voice '$($narrationSpec.voice)' is not installed/enabled. Available: $($installed -join ', ')"
}
$synth.SelectVoice($narrationSpec.voice)

$report = @()
foreach ($line in $narrationSpec.lines) {
  $path = Join-Path $OutDir ("s{0:D2}.wav" -f [int]$line.index)
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
  $ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">' +
          '<prosody rate="' + $line.rate + '" pitch="' + $line.pitch + '">' +
          $line.tts + '</prosody></speak>'
  $synth.SetOutputToWaveFile($path, $format)
  $synth.SpeakSsml($ssml)
  $synth.SetOutputToNull()
  if (-not (Test-Path -LiteralPath $path)) { throw "Sentence $($line.index) produced no audio file" }
  $bytes = (Get-Item -LiteralPath $path).Length
  if ($bytes -lt 2000) { throw "Sentence $($line.index) audio is too short ($bytes bytes)" }
  $report += [pscustomobject]@{ index = [int]$line.index; file = $path; bytes = $bytes }
  Write-Host ("s{0:D2} ok {1} bytes" -f [int]$line.index, $bytes)
}
$synth.Dispose()
$report | ConvertTo-Json -Depth 3 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $OutDir 'render-report.json')
