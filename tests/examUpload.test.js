import { describe, it, mock, before, after } from 'node:test';
import assert from 'node:assert';
import { convertFilesToPdf } from '../src/services/examConverter.js';
import { uploadExamFile } from '../src/services/storage.js';
import { setSupabaseClient, clearSupabaseClient } from '../src/supabaseClient.js';

describe('Exam File Processing', () => {
  describe('PDF Conversion', () => {
    it('should convert text files to PDF', async () => {
      const files = [
        { name: 'test.txt', type: 'text/plain', content: 'Hello World' }
      ];
      const pdfBuffer = await convertFilesToPdf(files);
      assert.ok(pdfBuffer instanceof Uint8Array);
      assert.ok(pdfBuffer.length > 0);
      // PDF header check
      const header = Buffer.from(pdfBuffer.slice(0, 5)).toString();
      assert.strictEqual(header, '%PDF-');
    });

    it('should handle multiple files', async () => {
      const files = [
        { name: 'file1.txt', type: 'text/plain', content: 'Page 1' },
        { name: 'file2.txt', type: 'text/plain', content: 'Page 2' }
      ];
      const pdfBuffer = await convertFilesToPdf(files);
      assert.ok(pdfBuffer.length > 0);
    });
  });

  describe('Storage Upload', () => {
    let mockSupabase;
    let uploadCalled = false;

    before(() => {
      mockSupabase = {
        storage: {
          from: (bucket) => ({
            upload: async (path, body, options) => {
              uploadCalled = true;
              assert.strictEqual(bucket, 'practice_exams');
              assert.ok(path.includes('user123/course456/'));
              return { data: { path }, error: null };
            },
            getPublicUrl: (path) => ({
              data: { publicUrl: `https://example.com/${path}` }
            })
          })
        }
      };
      setSupabaseClient(mockSupabase);
    });

    after(() => {
      clearSupabaseClient();
    });

    it('should upload file to correct path and return URL', async () => {
      const buffer = Buffer.from('fake pdf content');
      const url = await uploadExamFile('course456', 'user123', buffer, 'test.pdf');
      
      assert.ok(uploadCalled);
      assert.ok(url.includes('https://example.com/'));
      assert.ok(url.includes('user123/course456/'));
    });
  });
});
