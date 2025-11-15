import test from 'node:test';
import assert from 'node:assert/strict';
import { __courseV2Internals } from '../src/services/courseV2.js';

const { validateModuleCoverage, buildFallbackModulePlanFromTopics } = __courseV2Internals;

function createSyllabus(nodeCount = 12) {
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    id: `node-${index + 1}`,
    title: `Topic ${index + 1}`,
    summary: `Summary ${index + 1}`,
    refs: [],
  }));
  return {
    topic_graph: {
      nodes,
      edges: [],
    },
  };
}

function buildModulePlan(moduleCount, syllabus) {
  const nodes = syllabus.topic_graph.nodes;
  return {
    modules: Array.from({ length: moduleCount }, (_, index) => ({
      id: `module-${index + 1}`,
      title: `Module ${index + 1}`,
      dependsOn: [],
      outcomes: [`Outcome ${index + 1}`],
      hours_estimate: 10,
      covers_nodes: [nodes[index % nodes.length].id],
    })),
  };
}

test('validateModuleCoverage accepts plans with four modules', () => {
  const syllabus = createSyllabus();
  const plan = buildModulePlan(4, syllabus);
  assert.doesNotThrow(() => validateModuleCoverage(plan, syllabus));
});

test('validateModuleCoverage only warns for out-of-range counts', () => {
  const syllabus = createSyllabus();
  const plan = buildModulePlan(11, syllabus);
  const originalWarn = console.warn;
  let warningCount = 0;
  console.warn = () => {
    warningCount += 1;
  };
  try {
    validateModuleCoverage(plan, syllabus);
    assert.equal(warningCount, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test('validateModuleCoverage still throws when there are zero modules', () => {
  const syllabus = createSyllabus();
  assert.throws(() => validateModuleCoverage({ modules: [] }, syllabus), {
    message: /at least one module/i,
  });
});

test('buildFallbackModulePlanFromTopics produces deterministic coverage', () => {
  const syllabus = createSyllabus(9);
  const plan = buildFallbackModulePlanFromTopics(syllabus.topic_graph.nodes);
  assert.ok(plan.modules.length >= 4 && plan.modules.length <= 10);
  const covered = new Set(plan.modules.flatMap((module) => module.covers_nodes));
  assert.equal(covered.size, syllabus.topic_graph.nodes.length);
  for (const module of plan.modules) {
    assert.ok(Array.isArray(module.outcomes) && module.outcomes.length > 0);
    assert.ok(Number.isInteger(module.hours_estimate) && module.hours_estimate > 0);
  }
});
