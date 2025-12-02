import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

async function testLogParsing() {
  const logContent = `
This is some preamble.
! Undefined control sequence.
l.6 \\invalidcommand
                     
The control sequence at the end of the top line
of your error message was never defined. If you have
misspelled it (e.g., \\hobx'), type 'I' and the correct
spelling (e.g., 'I\\hbox'). Otherwise just continue,
and I'll forget about whatever was undefined.

! Emergency stop.
<*> ...
        
End of file on the terminal!
  `;

  const logPath = join(tmpdir(), `test_exam_${Date.now()}.log`);
  await fs.writeFile(logPath, logContent);

  console.log('Created mock log file at:', logPath);

  try {
    // Simulate the parsing logic
    const content = await fs.readFile(logPath, 'utf8');
    const lines = content.split('\n');
    const errorLines = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('!')) {
        errorLines.push(line);
        if (lines[i+1]) errorLines.push(lines[i+1]);
        if (lines[i+2]) errorLines.push(lines[i+2]);
      }
    }
    
    if (errorLines.length > 0) {
      console.log('--- Parsed Errors ---');
      console.log(errorLines.join('\n'));
      console.log('---------------------');
    } else {
      console.log('No errors found (unexpected)');
    }

    // Cleanup
    await fs.unlink(logPath);
  } catch (err) {
    console.error('Test failed:', err);
  }
}

testLogParsing();
