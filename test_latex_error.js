import latex from 'node-latex';
import { Readable } from 'stream';
import { createWriteStream } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

async function testLatexError() {
  const latexCode = `
    \\documentclass{article}
    \\begin{document}
    Hello World
    \\invalidcommand % This should cause an error
    \\end{document}
  `;

  const input = Readable.from([Buffer.from(latexCode)]);
  const outputPath = join(tmpdir(), `test_exam_${Date.now()}.pdf`);
  const output = createWriteStream(outputPath);
  const pdf = latex(input);

  pdf.pipe(output);

  pdf.on('error', (err) => {
    console.log('--- Error Object Keys ---');
    console.log(Object.keys(err));
    console.log('--- Error Message ---');
    console.log(err.message);
    console.log('--- Error Stack ---');
    console.log(err.stack);
    console.log('--- Full Error Object ---');
    console.log(err);
  });

  pdf.on('finish', () => {
    console.log('Compilation finished (unexpectedly success)');
  });
}

testLatexError();
