import { Readable } from 'stream';
import latex from 'node-latex';
import { createWriteStream } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

async function testLatex() {
  console.log('Testing LaTeX compilation...');
  const latexCode = `
\\documentclass{article}
\\begin{document}
Hello, World!
\\end{document}
  `;

  const input = Readable.from([Buffer.from(latexCode)]);
  const outputPath = join(tmpdir(), `test_exam_${Date.now()}.pdf`);
  const output = createWriteStream(outputPath);
  const pdf = latex(input);

  pdf.pipe(output);

  return new Promise((resolve, reject) => {
    pdf.on('error', (err) => {
      console.error('Compilation failed:', err);
      reject(err);
    });
    pdf.on('finish', () => {
      console.log('Compilation successful! PDF saved to:', outputPath);
      resolve();
    });
  });
}

testLatex().catch(console.error);
