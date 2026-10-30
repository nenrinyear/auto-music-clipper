import { parseWav, readWaveform } from './audio-processing.js';

self.onmessage = async ({ data: { file, plan } }) => {
  try {
    const peaks = await readWaveform(file, await parseWav(file), plan);
    self.postMessage({ peaks }, [peaks.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  }
};
