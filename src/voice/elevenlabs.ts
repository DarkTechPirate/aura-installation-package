const ELEVENLABS_API = 'https://api.elevenlabs.io/v1';

/**
 * Convert text to speech using ElevenLabs API.
 * Returns PCM audio buffer.
 */
export async function textToSpeech(
  text: string,
  voice_id: string,
  format: 'pcm_16000' | 'pcm_22050' | 'mp3_44100_128' = 'pcm_16000'
): Promise<Buffer> {
  const apiKey = process.env['ELEVENLABS_API_KEY'];
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');

  const res = await fetch(`${ELEVENLABS_API}/text-to-speech/${voice_id}/stream`, {
    method: 'POST',
    headers: {
      'xi-api-key':   apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      model_id:       'eleven_turbo_v2_5',
      output_format:  format,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!res.ok) {
    throw new Error(`ElevenLabs error ${res.status}: ${await res.text()}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

const CHUNK_SIZE = 1024; // 1KB per ANP audio_chunk command

/**
 * Stream TTS audio directly to an ANP body node as audio_chunk commands.
 * Sends 1KB chunks immediately without buffering full audio.
 */
export async function streamTTSToNode(
  text: string,
  voice_id: string,
  node_id: string,
  sendCommand: (node_id: string, cmd: string, payload: unknown) => void
): Promise<void> {
  const apiKey = process.env['ELEVENLABS_API_KEY'];
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');

  const res = await fetch(`${ELEVENLABS_API}/text-to-speech/${voice_id}/stream`, {
    method: 'POST',
    headers: {
      'xi-api-key':   apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      model_id:       'eleven_turbo_v2_5',
      output_format:  'pcm_16000',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`ElevenLabs stream error ${res.status}`);
  }

  const reader = res.body.getReader();
  let seq = 0;
  let buffer = Buffer.alloc(0);

  while (true) {
    const { done, value } = await reader.read();

    if (value) {
      buffer = Buffer.concat([buffer, Buffer.from(value)]);

      // Send complete 1KB chunks
      while (buffer.length >= CHUNK_SIZE) {
        const chunk = buffer.slice(0, CHUNK_SIZE);
        buffer = buffer.slice(CHUNK_SIZE);
        sendCommand(node_id, 'audio_chunk', {
          chunk_b64: chunk.toString('base64'),
          seq: seq++,
          final: false,
        });
      }
    }

    if (done) {
      // Send remaining buffer as final chunk
      sendCommand(node_id, 'audio_chunk', {
        chunk_b64: buffer.toString('base64'),
        seq: seq++,
        final: true,
      });
      break;
    }
  }
}
