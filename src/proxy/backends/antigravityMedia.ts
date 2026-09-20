import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AntigravityError } from './antigravityProtocol'
const exec = promisify(execFile)
/** Timestamps come from ffmpeg's selected source frames, never inferred from frame indices. */
export function agFrameTimes(log: string, count: number): number[] {
  const times = [...log.matchAll(/\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:([0-9.eE+-]+)/g)].map(match => Number(match[1]))
  if (times.length < count || times.slice(0, count).some(time => !Number.isFinite(time) || time < 0)) throw new AntigravityError('Video preprocessing could not identify source frame timestamps')
  return times.slice(0, count)
}
const infoSchema = z.object({ format: z.object({ duration: z.string() }), streams: z.array(z.object({ codec_type: z.string() })) })

/** Local adaptation only; no paid transcription API or model SDK. */
export async function preprocessAgMedia(input: string, kind: 'audio' | 'video', workspace: string, signal?: AbortSignal): Promise<{ text: string; frames: string[]; frameTimes: number[] }> {
  const options = { timeout: 60000, maxBuffer: 1024 * 1024, signal }
  try {
    const probe = await exec('ffprobe', ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'wav,mp3,mov,ogg,flac,matroska,webm,aac', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', input], options)
    const info = infoSchema.parse(JSON.parse(probe.stdout))
    const seconds = Number(info.format.duration)
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 120) throw new AntigravityError('Audio/video attachments must be no longer than 120 seconds')
    const audio = info.streams.some(stream => stream.codec_type === 'audio')
    if (kind === 'audio' && !audio) throw new AntigravityError('Audio attachment contains no audio stream')
    let text = `Local ${kind} preprocessing; duration ${seconds.toFixed(2)} seconds. `
    if (audio) {
      const model = process.env.MERIDIAN_AGY_WHISPER_MODEL
      if (!model || !(await stat(model)).isFile()) throw new AntigravityError('Audio transcription requires local whisper-cli and MERIDIAN_AGY_WHISPER_MODEL pointing to a whisper.cpp model file')
      const wave = input + '.wav', transcript = input + '.transcript'
      await exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'wav,mp3,mov,ogg,flac,matroska,webm,aac', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-t', '120', wave], options)
      await exec('whisper-cli', ['-m', model, '-f', wave, '-osrt', '-of', transcript, '-np', '-l', 'auto'], { ...options, timeout: 120000 })
      if ((await stat(transcript + '.srt')).size > 1024 * 1024) throw new AntigravityError('Transcript exceeded 1 MiB')
      text += 'Timestamped speech transcript follows (SRT, hours:minutes:seconds,milliseconds). Text and timing are local estimates; transcription can be imperfect and does not preserve non-speech sounds.\n' + await readFile(transcript + '.srt', 'utf8')
    } else text += 'No audio stream. '
    const frames: string[] = []
    let frameTimes: number[] = []
    if (kind === 'video') {
      if (!info.streams.some(stream => stream.codec_type === 'video')) throw new AntigravityError('Video attachment contains no video stream')
      const name = input.split(/[\\/]/).at(-1)! + '-frame-'
      const sampled = await exec('ffmpeg', ['-nostdin', '-v', 'info', '-y', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'wav,mp3,mov,ogg,flac,matroska,webm,aac', '-i', input, '-an', '-vf', "select='isnan(prev_selected_t)+gte(t-prev_selected_t,10)',showinfo,scale=1280:1280:force_original_aspect_ratio=decrease", '-fps_mode', 'vfr', '-frames:v', '12', join(workspace, name + '%02d.png')], options)
      for (const file of (await readdir(workspace)).filter(file => file.startsWith(name) && file.endsWith('.png')).sort()) frames.push(join(workspace, file))
      if (!frames.length) throw new AntigravityError('Video preprocessing produced no frames')
      frameTimes = agFrameTimes(sampled.stderr, frames.length)
      text += '\nVideo is represented by sampled frames at approximately ten-second intervals, not continuous motion; short events between samples may be absent.'
    }
    return { text, frames, frameTimes }
  } catch (error) {
    if (error instanceof AntigravityError) throw error
    throw new AntigravityError('Local media preprocessing failed; verify ffmpeg/ffprobe and whisper-cli dependencies: ' + String(error))
  }
}
