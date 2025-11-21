/**
 * Manual test for Study Plan Generator
 * Run with: node tests/studyPlan.manual.test.js
 * 
 * This script tests the algorithm logic without hitting the database.
 */

// Mock data structures
const mockNodes = [
    { id: 'A', title: 'Node A', estimated_minutes: 30, intrinsic_exam_value: 5, module_ref: 'M1', content_payload: { reading: 'content' } },
    { id: 'B', title: 'Node B', estimated_minutes: 30, intrinsic_exam_value: 5, module_ref: 'M1', content_payload: { reading: 'content' } },
    { id: 'C', title: 'Node C', estimated_minutes: 30, intrinsic_exam_value: 8, module_ref: 'M2', content_payload: { reading: 'content' } },
    { id: 'D', title: 'Node D', estimated_minutes: 30, intrinsic_exam_value: 8, module_ref: 'M2', content_payload: { reading: 'content' } },
];

const mockEdges = [
    { parent_id: 'A', child_id: 'B' },
    { parent_id: 'B', child_id: 'C' },
    { parent_id: 'B', child_id: 'D' },
];

const mockUserState = new Map([
    ['A', { node_id: 'A', familiarity_score: 0.1, mastery_status: 'pending' }],
    ['B', { node_id: 'B', familiarity_score: 0.1, mastery_status: 'pending' }],
    ['C', { node_id: 'C', familiarity_score: 0.1, mastery_status: 'pending' }],
    ['D', { node_id: 'D', familiarity_score: 0.1, mastery_status: 'pending' }],
]);

// Copied algorithm logic from studyPlan.js for testing
function buildGraph(nodes, edges) {
    const nodeMap = new Map();
    nodes.forEach((node) => {
        nodeMap.set(node.id, { ...node, children: [], parents: [] });
    });

    edges.forEach((edge) => {
        const parent = nodeMap.get(edge.parent_id);
        const child = nodeMap.get(edge.child_id);
        if (parent && child) {
            parent.children.push(child.id);
            child.parents.push(parent.id);
        }
    });

    return nodeMap;
}

function hydrateNodes(nodeMap, userStateMap) {
    for (const node of nodeMap.values()) {
        const state = userStateMap.get(node.id);
        node.userState = state || {};
        const familiarity = state?.familiarity_score || 0.1;
        node.effective_cost = (node.estimated_minutes || 30) * (1 - familiarity);
    }
}

function calculateTotalTimeNeeded(nodeMap) {
    let total = 0;
    for (const node of nodeMap.values()) {
        total += node.effective_cost;
    }
    return total;
}

function getAllAncestors(nodeMap, nodeId, visited = new Set()) {
    const node = nodeMap.get(nodeId);
    if (!node) return [];

    let ancestors = [];
    for (const parentId of node.parents) {
        if (!visited.has(parentId)) {
            visited.add(parentId);
            const parent = nodeMap.get(parentId);
            if (parent) {
                ancestors.push(parent);
                ancestors = ancestors.concat(getAllAncestors(nodeMap, parentId, visited));
            }
        }
    }
    return ancestors;
}

function runCramModeAlgorithm(nodeMap, minutesAvailable) {
    let targets = Array.from(nodeMap.values()).filter((node) => (node.intrinsic_exam_value || 0) >= 7);

    if (targets.length === 0) {
        const allNodes = Array.from(nodeMap.values()).sort(
            (a, b) => (b.intrinsic_exam_value || 0) - (a.intrinsic_exam_value || 0)
        );
        const cutoff = Math.ceil(allNodes.length * 0.2);
        targets = allNodes.slice(0, cutoff);
    }

    const chains = targets
        .map((target) => {
            const ancestors = getAllAncestors(nodeMap, target.id);
            const missingAncestors = ancestors.filter((n) => n.userState.mastery_status !== 'mastered');

            const chainNodes = [...missingAncestors];
            if (target.userState.mastery_status !== 'mastered') {
                if (!chainNodes.find((n) => n.id === target.id)) {
                    chainNodes.push(target);
                }
            }

            return {
                target,
                nodes: chainNodes,
                cost: chainNodes.reduce((sum, n) => sum + n.effective_cost, 0),
            };
        })
        .filter((chain) => chain.nodes.length > 0);

    const selectedNodeIds = new Set();
    let remainingTime = minutesAvailable;
    const finalSelectedNodes = [];

    console.log('\n🎯 Cram Mode Selection Process:');
    console.log(`Initial time available: ${minutesAvailable} mins\n`);

    let iteration = 0;
    while (remainingTime > 0 && chains.length > 0) {
        iteration++;
        console.log(`--- Iteration ${iteration} ---`);

        // Recalculate Marginal Cost & ROI
        chains.forEach((chain) => {
            const marginalCost = chain.nodes.reduce((sum, node) => {
                return selectedNodeIds.has(node.id) ? sum : sum + node.effective_cost;
            }, 0);

            chain.marginalCost = marginalCost;
            chain.roi = marginalCost === 0 ? Infinity : (chain.target.intrinsic_exam_value || 0) / marginalCost;

            console.log(`Chain to ${chain.target.id}: marginal=${marginalCost.toFixed(1)}, ROI=${chain.roi.toFixed(3)}`);
        });

        chains.sort((a, b) => b.roi - a.roi);
        const bestChain = chains[0];

        console.log(`Best: Chain to ${bestChain.target.id} (marginal=${bestChain.marginalCost.toFixed(1)})`);

        if (bestChain.marginalCost <= remainingTime) {
            remainingTime -= bestChain.marginalCost;
            const newNodes = [];
            bestChain.nodes.forEach((node) => {
                if (!selectedNodeIds.has(node.id)) {
                    selectedNodeIds.add(node.id);
                    finalSelectedNodes.push(node);
                    newNodes.push(node.id);
                }
            });
            console.log(`✅ Selected! Added nodes: ${newNodes.join(', ')}`);
            console.log(`Remaining time: ${remainingTime.toFixed(1)} mins\n`);
            chains.shift();
        } else {
            console.log(`❌ Doesn't fit. Removing from candidates.\n`);
            chains.shift();
        }
    }

    return finalSelectedNodes;
}

function topologicalSort(nodeMap, nodesToInclude = null) {
    const visited = new Set();
    const sorted = [];
    const tempVisited = new Set();

    const nodes = nodesToInclude ? nodesToInclude : Array.from(nodeMap.values());

    function visit(nodeId) {
        if (tempVisited.has(nodeId)) {
            // Cycle detected, just return
            return;
        }
        if (visited.has(nodeId)) return;

        tempVisited.add(nodeId);

        const node = nodeMap.get(nodeId);
        if (node) {
            // Visit parents first (prerequisites)
            for (const parentId of node.parents) {
                // Only visit if the parent is in our set of interest (if filtered)
                if (!nodesToInclude || nodesToInclude.find((n) => n.id === parentId)) {
                    visit(parentId);
                }
            }
        }

        visited.add(nodeId);
        tempVisited.delete(nodeId);
        sorted.push(nodeMap.get(nodeId));
    }

    for (const node of nodes) {
        visit(node.id);
    }

    return sorted;
}

function runCramModeAlgorithmWithSort(nodeMap, minutesAvailable) {
    const unsortedNodes = runCramModeAlgorithm(nodeMap, minutesAvailable);
    return topologicalSort(nodeMap, unsortedNodes);
}

// Test 1: Shared Ancestor Logic
console.log('='.repeat(60));
console.log('TEST 1: Shared Ancestor Logic');
console.log('='.repeat(60));
console.log('Graph: A -> B -> C');
console.log('       A -> B -> D');
console.log('Values: C=8, D=8');
console.log('Familiarity: 0.1 for all');
console.log('Effective cost per node: ~27 mins');

const graph1 = buildGraph(mockNodes, mockEdges);
hydrateNodes(graph1, mockUserState);

const totalTime = calculateTotalTimeNeeded(graph1);
console.log(`\nTotal time needed: ${totalTime.toFixed(1)} mins`);
console.log(`Deep Study threshold (1.5x): ${(totalTime * 1.5).toFixed(1)} mins`);

const result1 = runCramModeAlgorithmWithSort(graph1, 110);
console.log(`\n✅ Final selected nodes (sorted): ${result1.map(n => n.id).join(', ')}`);
console.log(`Expected: A, B, C, D (all nodes in topological order)`);

// Verify the order
const nodeIds = result1.map(n => n.id);
if (nodeIds[0] === 'A' && nodeIds[1] === 'B' && nodeIds.length === 4) {
    console.log('✓ Topological order verified: A comes before B ✓');
} else {
    console.log(`✗ ERROR: Expected A first, B second, got ${nodeIds.join(', ')}`);
}

// Test 2: Zero Target Fallback
console.log('\n' + '='.repeat(60));
console.log('TEST 2: Zero Target Fallback');
console.log('='.repeat(60));

const lowValueNodes = mockNodes.map(n => ({ ...n, intrinsic_exam_value: 5 }));
lowValueNodes[2].intrinsic_exam_value = 6; // C slightly higher but < 7
const graph2 = buildGraph(lowValueNodes, mockEdges);
hydrateNodes(graph2, mockUserState);

console.log('All nodes have value < 7');
console.log('Should fallback to top 20% (1 node)');

const result2 = runCramModeAlgorithmWithSort(graph2, 90);
console.log(`\n✅ Final selected nodes (sorted): ${result2.map(n => n.id).join(', ')}`);
console.log(`Expected: A, B, C (chain in topological order)`);

// Verify the order
const nodeIds2 = result2.map(n => n.id);
if (nodeIds2[0] === 'A' && nodeIds2[1] === 'B' && nodeIds2[2] === 'C') {
    console.log('✓ Topological order verified: A -> B -> C ✓');
} else {
    console.log(`✗ ERROR: Expected A, B, C in order, got ${nodeIds2.join(', ')}`);
}

console.log('\n' + '='.repeat(60));
console.log('All tests completed! Review output above.');
console.log('='.repeat(60));
