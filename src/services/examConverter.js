import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

/**
 * Converts an array of files to a single PDF buffer.
 * Supported types:
 * - Images (PNG, JPG, JPEG)
 * - Text (TXT, MD, etc.)
 * - PDF (merged)
 * 
 * @param {Array<{name: string, type: string, content: Buffer|string}>} files 
 * @returns {Promise<Uint8Array>} The generated PDF buffer
 */
export async function convertFilesToPdf(files) {
  if (!files || files.length === 0) {
    throw new Error('No files provided for conversion');
  }

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  for (const file of files) {
    try {
      if (isImage(file)) {
        await addImageToPdf(pdfDoc, file);
      } else if (isPdf(file)) {
        await mergePdf(pdfDoc, file);
      } else {
        // Treat as text by default
        await addTextToPdf(pdfDoc, file, font);
      }
    } catch (error) {
      console.error(`Failed to process file ${file.name}:`, error);
      // Add an error page for this file
      const page = pdfDoc.addPage();
      page.drawText(`Error processing file: ${file.name}\n${error.message}`, {
        x: 50,
        y: page.getHeight() - 50,
        size: 12,
        font,
        color: rgb(1, 0, 0),
      });
    }
  }

  return await pdfDoc.save();
}

function isImage(file) {
  const type = file.type?.toLowerCase() || '';
  const name = file.name?.toLowerCase() || '';
  return type.startsWith('image/') || name.match(/\.(jpg|jpeg|png)$/);
}

function isPdf(file) {
  const type = file.type?.toLowerCase() || '';
  const name = file.name?.toLowerCase() || '';
  return type === 'application/pdf' || name.endsWith('.pdf');
}

async function addImageToPdf(pdfDoc, file) {
  let image;
  const content = typeof file.content === 'string' 
    ? Buffer.from(file.content, 'base64') 
    : file.content;

  try {
    if (file.type?.includes('png') || file.name?.toLowerCase().endsWith('.png')) {
      image = await pdfDoc.embedPng(content);
    } else {
      image = await pdfDoc.embedJpg(content);
    }
  } catch (e) {
    // Fallback: try the other format if the first one fails (sometimes extensions lie)
    try {
      if (file.type?.includes('png')) {
        image = await pdfDoc.embedJpg(content);
      } else {
        image = await pdfDoc.embedPng(content);
      }
    } catch (e2) {
      throw new Error('Invalid or unsupported image format');
    }
  }

  const page = pdfDoc.addPage();
  const { width, height } = image.scale(1);
  
  // Scale down if too big for the page
  const maxWidth = page.getWidth() - 100;
  const maxHeight = page.getHeight() - 100;
  
  let scale = 1;
  if (width > maxWidth) scale = Math.min(scale, maxWidth / width);
  if (height > maxHeight) scale = Math.min(scale, maxHeight / height);

  const dims = image.scale(scale);

  page.drawImage(image, {
    x: (page.getWidth() - dims.width) / 2,
    y: (page.getHeight() - dims.height) / 2,
    width: dims.width,
    height: dims.height,
  });
  
  // Add filename caption
  page.drawText(file.name, {
    x: 50,
    y: 20,
    size: 10,
    color: rgb(0, 0, 0),
  });
}

async function mergePdf(pdfDoc, file) {
  const content = typeof file.content === 'string' 
    ? Buffer.from(file.content, 'base64') 
    : file.content;
    
  const srcDoc = await PDFDocument.load(content);
  const copiedPages = await pdfDoc.copyPages(srcDoc, srcDoc.getPageIndices());
  
  copiedPages.forEach((page) => {
    pdfDoc.addPage(page);
  });
}

async function addTextToPdf(pdfDoc, file, font) {
  const page = pdfDoc.addPage();
  const { width, height } = page.getSize();
  const fontSize = 10;
  const margin = 50;
  
  let text = '';
  if (typeof file.content === 'string') {
    // Check if it's base64 encoded (simple check)
    if (file.content.match(/^[A-Za-z0-9+/=]+$/) && file.content.length % 4 === 0) {
       try {
         text = Buffer.from(file.content, 'base64').toString('utf-8');
       } catch (e) {
         text = file.content;
       }
    } else {
      text = file.content;
    }
  } else if (Buffer.isBuffer(file.content)) {
    text = file.content.toString('utf-8');
  }

  // Sanitize text for PDF (remove non-printable characters)
  text = text.replace(/[^\x20-\x7E\n\r\t]/g, '');

  page.drawText(`File: ${file.name}`, {
    x: margin,
    y: height - margin,
    size: 14,
    font,
    color: rgb(0, 0, 0),
  });

  // Simple text wrapping (very basic)
  const lines = text.split('\n');
  let y = height - margin - 30;
  
  for (const line of lines) {
    if (y < margin) {
      // New page needed
      // For simplicity in this v1, we just truncate or stop. 
      // A robust implementation would add a new page.
      break; 
    }
    
    // Split long lines
    const maxChars = 90; // Approx for 10pt font
    const chunks = line.match(new RegExp(`.{1,${maxChars}}`, 'g')) || [''];
    
    for (const chunk of chunks) {
       if (y < margin) break;
       page.drawText(chunk, {
         x: margin,
         y,
         size: fontSize,
         font,
         color: rgb(0, 0, 0),
       });
       y -= fontSize + 4;
    }
  }
}
/**
 * Converts a single file to an individual PDF buffer.
 * 
 * @param {{name: string, type: string, content: Buffer|string}} file 
 * @returns {Promise<Uint8Array>} The generated PDF buffer for this single file
 */
export async function convertSingleFileToPdf(file) {
  if (!file) {
    throw new Error('No file provided for conversion');
  }

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  try {
    if (isImage(file)) {
      await addImageToPdf(pdfDoc, file);
    } else if (isPdf(file)) {
      // If it's already a PDF, just return the content
      const content = typeof file.content === 'string' 
        ? Buffer.from(file.content, 'base64') 
        : file.content;
      return content;
    } else {
      // Treat as text by default
      await addTextToPdf(pdfDoc, file, font);
    }
  } catch (error) {
    console.error(Failed to process file :, error);
    // Add an error page for this file
    const page = pdfDoc.addPage();
    page.drawText(Error processing file: \n, {
      x: 50,
      y: page.getHeight() - 50,
      size: 12,
      font,
      color: rgb(1, 0, 0),
    });
  }

  return await pdfDoc.save();
}
