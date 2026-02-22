import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';

export class FFmpegConverter {
  /**
   * Spawns an FFmpeg process to seamlessly handle buffer-to-buffer conversion.
   */
  static async convert(inputBuffer: Buffer, args: string[], extIn: string, extOut: string): Promise<Buffer> {
    const tmpDir = path.join(os.tmpdir(), 'elastrax-tmp');
    await fs.mkdir(tmpDir, { recursive: true });

    const randId = crypto.randomBytes(8).toString('hex');
    const tmpIn = path.join(tmpDir, `${randId}.${extIn}`);
    const tmpOut = path.join(tmpDir, `${randId}.${extOut}`);

    await fs.writeFile(tmpIn, inputBuffer);

    const ffmpegArgs = [
      '-y',
      '-i', tmpIn,
      ...args,
      tmpOut
    ];

    return new Promise((resolve, reject) => {
      // It is assumed ffmpeg is installed on the host system
      const child = spawn('ffmpeg', ffmpegArgs);
      let stderr = '';

      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', async (code) => {
        try {
          // Cleanup temp input
          await fs.unlink(tmpIn).catch(() => {});
          
          if (code !== 0) {
            await fs.unlink(tmpOut).catch(() => {});
            return reject(new Error(`FFmpeg error ${code}: ${stderr}`));
          }
          
          // Read success output and cleanup
          const data = await fs.readFile(tmpOut);
          await fs.unlink(tmpOut).catch(() => {});
          resolve(data);
        } catch (e) {
          reject(e);
        }
      });
    });
  }
}
