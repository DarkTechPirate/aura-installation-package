/**
 * Speech-to-text using OpenAI Whisper API.
 * Converts audio buffer to text transcript.
 */
export async function speechToText(
  audioBuffer: Buffer,
  filename = 'audio.wav'
): Promise<string> {
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) throw new Error('OPENAI_API_KEY not set for Whisper STT');

  const formData = new FormData();
  const ab: ArrayBuffer = audioBuffer.buffer instanceof SharedArrayBuffer
    ? new Uint8Array(audioBuffer).buffer
    : audioBuffer.buffer.slice(audioBuffer.byteOffset, audioBuffer.byteOffset + audioBuffer.byteLength) as ArrayBuffer;
  const blob = new Blob([ab], { type: 'audio/wav' });
  formData.append('file', blob, filename);
  formData.append('model', 'whisper-1');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!res.ok) throw new Error(`Whisper error ${res.status}: ${await res.text()}`);

  const data = await res.json() as { text: string };
  return data.text;
}
