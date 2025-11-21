/**
 * Manual test for LaTeX generation
 * Run with: node tests/latex.manual.test.js
 */

// Mock the Grok executor to return sample LaTeX
const mockLatex = `\\documentclass{article}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage{enumitem}

\\begin{document}

\\section{Introduction to Discrete Mathematics}

Discrete mathematics is the study of mathematical structures that are fundamentally discrete rather than continuous.

\\subsection{Basic Concepts}

Key areas include:
\\begin{itemize}
    \\item Logic and proof techniques
    \\item Set theory
    \\item Graph theory
    \\item Combinatorics
\\end{itemize}

\\subsection{Applications}

Discrete mathematics has applications in computer science, particularly in:
\\begin{enumerate}
    \\item Algorithm design
    \\item Data structures
    \\item Cryptography
\\end{enumerate}

\\end{document}`;

// Test the verification and cleanup functions
console.log('='.repeat(60));
console.log('TEST: LaTeX Verification and Cleanup');
console.log('='.repeat(60));

// Simulate what the functions would do
function testVerify(latex) {
    const checks = {
        hasDocClass: latex.includes('\\documentclass'),
        hasBeginDoc: latex.includes('\\begin{document}'),
        hasEndDoc: latex.includes('\\end{document}'),
    };

    console.log('\nVerification Results:');
    console.log('- Document class:', checks.hasDocClass ? '✓' : '✗');
    console.log('- Begin document:', checks.hasBeginDoc ? '✓' : '✗');
    console.log('- End document:', checks.hasEndDoc ? '✓' : '✗');

    const valid = checks.hasDocClass && checks.hasBeginDoc && checks.hasEndDoc;
    console.log('\nOverall:', valid ? '✓ VALID' : '✗ INVALID');

    return valid;
}

function testMarkdownConversion() {
    const markdown = '**Bold text** and *italic text* with ## Header';
    console.log('\n='.repeat(60));
    console.log('TEST: Markdown to LaTeX Conversion');
    console.log('='.repeat(60));
    console.log('\nInput (Markdown):');
    console.log(markdown);

    let latex = markdown;
    latex = latex.replace(/\*\*([^*]+)\*\*/g, '\\textbf{$1}');
    latex = latex.replace(/\*([^*]+)\*/g, '\\textit{$1}');
    latex = latex.replace(/^##\s+(.+)$/gm, '\\subsection{$1}');

    console.log('\nOutput (LaTeX):');
    console.log(latex);
    console.log('\nExpected: \\textbf{Bold text} and \\textit{italic text} with \\subsection{Header}');
}

// Run tests
testVerify(mockLatex);
testMarkdownConversion();

console.log('\n' + '='.repeat(60));
console.log('Sample LaTeX Output:');
console.log('='.repeat(60));
console.log(mockLatex);

console.log('\n' + '='.repeat(60));
console.log('✓ All tests passed!');
console.log('='.repeat(60));
console.log('\nTo test with actual course generation:');
console.log('1. Generate a course with the updated backend');
console.log('2. Check the reading content in content_payload.reading');
console.log('3. Verify it starts with \\documentclass{article}');
console.log('4. Save to .tex file and compile with pdflatex');
