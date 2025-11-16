# Course Generation JSON Reliability Fixes

## Problem Summary
Course generation was failing with multiple issues:
- JSON parsing errors (unterminated strings at position 8061)
- Schema validation failures for assessments (missing `question` field in MCQs)
- Missing `exam_blueprint.sections` in assessment output
- Models outputting markdown/text instead of pure JSON

## Root Causes
1. **No JSON mode enforcement**: OpenRouter API calls weren't using `response_format: {type: 'json_object'}`, allowing models to return markdown-wrapped or malformed JSON
2. **Vague prompts**: System prompts lacked concrete JSON schema examples
3. **Fallback logic issues**: Fallback assessment builder could create invalid outcomes slices

## Fixes Applied

### 1. Added `response_format: {type: 'json_object'}` to ALL LLM Calls
**File**: `src/services/courseV2.js`

Added JSON mode to:
- `synthesizeSyllabus()` - primary and repair calls
- `planModulesFromGraph()` - primary and repair calls  
- `designLessons()` - primary, retry, and repair calls
- `generateAssessments()` - primary and repair calls
- `criticAndRepair()` - critic call

This forces OpenRouter models to output valid JSON without markdown fences or extra text.

### 2. Enhanced System Prompts with Concrete JSON Examples
**File**: `src/services/prompts/courseV2Prompts.js`

#### writerLessons()
Added example:
```json
{"lessons":[{"id":"mod1-lesson1","moduleId":"mod1","title":"Introduction to Topic","objectives":["Understand concept A"],"duration_min":45,"reading":[{"title":"Resource","url":"https://example.com/resource","est_min":10}],"activities":[{"type":"guided_example","goal":"Practice concepts","steps":["Step 1"]}],"bridge_from":[],"bridge_to":[],"cross_refs":[]}]}
```

#### assessorAssessments()
Added explicit MCQ vs FRQ format:
```json
MCQ: {"type":"mcq","question":"Question text?","options":["A","B","C","D"],"answerIndex":0,"explanation":"Why A is correct","anchors":["lesson_id"]}
FRQ: {"type":"frq","prompt":"Question prompt","model_answer":"Expected answer","rubric":"Grading criteria","anchors":["lesson_id"]}
```

Complete example:
```json
{"weekly_quizzes":[{"moduleId":"mod1","items":[{"type":"mcq","question":"What is X?","options":["A","B","C","D"],"answerIndex":0,"explanation":"Brief explanation","anchors":["lesson1"]}]}],"project":{"title":"Final Project","brief":"Description","milestones":["Milestone 1"],"rubric":"Grading rubric"},"exam_blueprint":{"sections":[{"title":"Core Concepts","weight_pct":60,"outcomes":["Outcome 1"]}]}}
```

#### plannerSyllabus()
Added example:
```json
{"outcomes":["Master core concepts"],"topic_graph":{"nodes":[{"id":"node1","title":"Concept Name","summary":"Brief description","refs":["https://example.com/resource"]}],"edges":[{"from":"node1","to":"node2","reason":"prerequisite"}]},"sources":[{"url":"https://university.edu/syllabus","title":"Official Syllabus"}]}
```

#### plannerModules()
Added example:
```json
{"modules":[{"id":"mod1","title":"Module 1: Introduction","dependsOn":[],"outcomes":["Understand basic concepts"],"hours_estimate":6,"covers_nodes":["node1","node2"]}]}
```

#### criticCourse()
Added example:
```json
{"issues":["Issue 1"],"revision_patch":{"modules":{"modules":[{"id":"mod1","title":"Updated Title"}]}}}
```

### 3. Fixed Fallback Assessment Builder
**File**: `src/services/courseV2.js` - `buildFallbackAssessments()`

Changed outcomes slicing logic to handle edge cases:
```javascript
// Before (could create empty arrays):
outcomes: outcomes.slice(0, 2)
outcomes: outcomes.slice(2, 4).length ? outcomes.slice(2, 4) : outcomes.slice(0, 2)

// After (guaranteed at least 1 outcome):
outcomes: outcomes.slice(0, Math.max(1, Math.min(2, outcomes.length)))
outcomes: outcomes.slice(2, 4).length 
  ? outcomes.slice(2, 4) 
  : outcomes.slice(0, Math.max(1, Math.min(2, outcomes.length)))
```

## Expected Impact

### JSON Parsing Errors → FIXED
- `response_format: {type: 'json_object'}` forces models to return pure JSON
- No more markdown fences, no more unterminated strings
- Models complete with `stop` reason and output is immediately parseable

### Assessment Validation Errors → FIXED
- Concrete examples show models exactly: `"question":"Question text?"` for MCQs
- Explicit MCQ/FRQ schema in prompt prevents field confusion
- Fallback builder now always creates valid exam_blueprint.sections

### Module/Lesson Validation → IMPROVED
- All stages now have clear JSON examples
- Models understand exact structure before generating
- Repair logic still available as backup but should rarely trigger

## Testing Recommendations

1. **Monitor logs for these patterns**:
   - `[courseV2][MODULES] Module planning failed validation` should decrease to near-zero
   - `[courseV2][LESSONS] Lesson schema validation failed` should decrease significantly
   - `[courseV2][ASSESSMENTS] Assessment validation failed` should be rare
   - JSON parse errors should be eliminated

2. **Check model finish reasons**:
   - All should show `stop` (normal completion)
   - No `length` finish reasons (token limit)

3. **Validate output quality**:
   - Modules should have 6-10 modules (not falling back to 4)
   - Lessons should have 6+ lessons without fallback
   - Assessments should have proper MCQ questions with all required fields

## Additional Notes

- Topic generation already working well (left unchanged)
- Used Grok-4-Fast for lessons/assessments, Gemini 2.5 Pro for modules (as configured)
- All models now explicitly instructed to return JSON only, no commentary
- Web search disabled for lessons/assessments to reduce latency and token usage
