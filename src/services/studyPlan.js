import { getSupabase } from '../supabaseClient.js';

/**
 * Generates an optimized study plan for a course based on available time.
 * @param {string} courseId - The ID of the course.
 * @param {string} userId - The ID of the user.
 * @param {number} hoursAvailable - The number of hours the user has available.
 * @returns {Promise<object>} - The study plan object.
 */
export async function generateStudyPlan(courseId, userId) {
    if (!courseId || !userId) {
        throw new Error('Missing required parameters: courseId, userId');
    }

    // 1. Data Fetching & Hydration
    const { nodes, edges, userStateMap, course } = await fetchData(courseId, userId);
    
    // Determine available time from DB
    const secondsToComplete = course?.seconds_to_complete;
    if (typeof secondsToComplete !== 'number' || secondsToComplete <= 0) {
        // Fallback or error? Let's error for now as per requirement "use the seconds_to_complete field"
        // Or maybe default to a reasonable time if not set? 
        // Given the user explicitly asked to use this field, missing it implies the course isn't ready for planning.
        throw new Error('Course time limit (seconds_to_complete) is not set');
    }
    
    const minutesAvailable = secondsToComplete / 60;

    const graph = buildGraph(nodes, edges);
    hydrateNodes(graph, userStateMap);

    // 2. Mode Selection
    const totalTimeNeeded = calculateTotalTimeNeeded(graph);
    const mode = minutesAvailable >= totalTimeNeeded * 1.5 ? 'Deep Study' : 'Cram';

    // 3. Optimization Algorithms
    let sortedNodes;
    if (mode === 'Deep Study') {
        sortedNodes = runDeepStudyAlgorithm(graph);
    } else {
        sortedNodes = runCramModeAlgorithm(graph, minutesAvailable);
    }

    // 4. Output Formatting
    return formatOutput(mode, sortedNodes, graph);
}

async function fetchData(courseId, userId) {
    const supabase = getSupabase();

    const [nodesResult, edgesResult, userStateResult, courseResult] = await Promise.all([
        supabase.schema('api').from('course_nodes').select('*').eq('course_id', courseId),
        supabase.schema('api').from('node_dependencies').select('*').eq('course_id', courseId),
        supabase.schema('api').from('user_node_state').select('*').eq('course_id', courseId).eq('user_id', userId),
        supabase.schema('api').from('courses').select('seconds_to_complete').eq('id', courseId).single(),
    ]);

    if (nodesResult.error) throw new Error(`Failed to fetch nodes: ${nodesResult.error.message}`);
    if (edgesResult.error) throw new Error(`Failed to fetch edges: ${edgesResult.error.message}`);
    if (userStateResult.error) throw new Error(`Failed to fetch user state: ${userStateResult.error.message}`);
    if (courseResult.error) throw new Error(`Failed to fetch course info: ${courseResult.error.message}`);

    const userStateMap = new Map();
    userStateResult.data.forEach((state) => {
        userStateMap.set(state.node_id, state);
    });

    return {
        nodes: nodesResult.data,
        edges: edgesResult.data,
        userStateMap,
        course: courseResult.data,
    };
}

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
        // Exclude mastered nodes from time calculation
        if (node.userState.mastery_status !== 'mastered') {
            total += node.effective_cost;
        }
    }
    return total;
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

function runDeepStudyAlgorithm(nodeMap) {
    // Filter out mastered nodes for the study plan
    const nodesToStudy = Array.from(nodeMap.values()).filter(
        (node) => node.userState.mastery_status !== 'mastered'
    );

    // Get mastered nodes to include in final output
    const masteredNodes = Array.from(nodeMap.values()).filter(
        (node) => node.userState.mastery_status === 'mastered'
    );

    // Topological sort of nodes to study
    const studyPlan = topologicalSort(nodeMap, nodesToStudy);

    // Merge mastered nodes back in their original positions
    // We'll do a full topological sort of ALL nodes to get the correct order
    const allNodesSorted = topologicalSort(nodeMap);

    return allNodesSorted;
}

function runCramModeAlgorithm(nodeMap, minutesAvailable) {
    // 1. Identify Target Nodes (exclude mastered)
    let targets = Array.from(nodeMap.values()).filter(
        (node) => (node.intrinsic_exam_value || 0) >= 7 && node.userState.mastery_status !== 'mastered'
    );

    // Fallback: If no targets, top 20% by value (exclude mastered)
    if (targets.length === 0) {
        const allNodes = Array.from(nodeMap.values())
            .filter((node) => node.userState.mastery_status !== 'mastered')
            .sort((a, b) => (b.intrinsic_exam_value || 0) - (a.intrinsic_exam_value || 0));
        const cutoff = Math.ceil(allNodes.length * 0.2);
        targets = allNodes.slice(0, cutoff);
    }

    // 2. Build Chains
    const chains = targets
        .map((target) => {
            const ancestors = getAllAncestors(nodeMap, target.id);
            // Filter ancestors that are not mastered
            const missingAncestors = ancestors.filter((n) => n.userState.mastery_status !== 'mastered');

            const chainNodes = [...missingAncestors];
            if (target.userState.mastery_status !== 'mastered') {
                // Avoid duplicates if target is its own ancestor
                if (!chainNodes.find((n) => n.id === target.id)) {
                    chainNodes.push(target);
                }
            }

            return {
                target,
                nodes: chainNodes,
                // Initial cost for sorting (will be dynamic later)
                cost: chainNodes.reduce((sum, n) => sum + n.effective_cost, 0),
            };
        })
        .filter((chain) => chain.nodes.length > 0); // Remove empty chains (fully mastered)

    // 3. Dynamic Greedy Selection
    const selectedNodeIds = new Set();
    let remainingTime = minutesAvailable;
    const finalSelectedNodes = [];

    while (remainingTime > 0 && chains.length > 0) {
        // Recalculate Marginal Cost & ROI
        chains.forEach((chain) => {
            const marginalCost = chain.nodes.reduce((sum, node) => {
                return selectedNodeIds.has(node.id) ? sum : sum + node.effective_cost;
            }, 0);

            chain.marginalCost = marginalCost;
            // Avoid division by zero. If cost is 0 (all nodes selected), ROI is infinite.
            chain.roi = marginalCost === 0 ? Infinity : (chain.target.intrinsic_exam_value || 0) / marginalCost;
        });

        // Sort by ROI descending
        chains.sort((a, b) => b.roi - a.roi);

        // Pick best
        const bestChain = chains[0];

        // If marginal cost fits in remaining time
        if (bestChain.marginalCost <= remainingTime) {
            remainingTime -= bestChain.marginalCost;
            bestChain.nodes.forEach((node) => {
                if (!selectedNodeIds.has(node.id)) {
                    selectedNodeIds.add(node.id);
                    finalSelectedNodes.push(node);
                }
            });
            // Remove from candidates
            chains.shift();
        } else {
            // If it doesn't fit, try next chain
            chains.shift();
        }
    }

    // 4. Merge mastered nodes back in and sort
    // Get all nodes (including mastered) that should be in the final output
    const selectedSet = new Set(finalSelectedNodes.map(n => n.id));
    const allNodesToInclude = Array.from(nodeMap.values()).filter(
        (node) => selectedSet.has(node.id) || node.userState.mastery_status === 'mastered'
    );

    return topologicalSort(nodeMap, allNodesToInclude);
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

function formatOutput(mode, sortedNodes, nodeMap) {
    const modulesMap = new Map();
    let totalMinutes = 0;

    sortedNodes.forEach((node) => {
        const moduleTitle = node.module_ref || 'General';
        if (!modulesMap.has(moduleTitle)) {
            modulesMap.set(moduleTitle, { title: moduleTitle, lessons: [] });
        }

        // Determine type from content_payload
        let type = 'reading';
        if (node.content_payload) {
            if (node.content_payload.reading) type = 'reading';
            else if (node.content_payload.video) type = 'video';
            else if (node.content_payload.quiz) type = 'quiz';
        }

        // Check if locked (only locked if any parent is in "pending" state)
        let isLocked = false;
        if (nodeMap) {
            const fullNode = nodeMap.get(node.id);
            if (fullNode && fullNode.parents) {
                for (const parentId of fullNode.parents) {
                    const parent = nodeMap.get(parentId);
                    // Node is locked only if any parent is in "pending" state
                    // If parent is "mastered" or "needs_review", the node is unlocked
                    const parentStatus = parent?.userState?.mastery_status || 'pending';
                    if (parentStatus === 'pending') {
                        isLocked = true;
                        break;
                    }
                }
            }
        }

        // Mastered nodes have 0 duration and don't count toward total time
        const isMastered = node.userState.mastery_status === 'mastered';
        const duration = isMastered ? 0 : Math.round(node.effective_cost);

        if (!isMastered) {
            totalMinutes += node.effective_cost;
        }

        modulesMap.get(moduleTitle).lessons.push({
            id: node.id,
            title: node.title,
            type,
            duration,
            is_locked: isLocked,
            status: node.userState.mastery_status || 'pending'
        });
    });

    return {
        mode,
        total_minutes: Math.round(totalMinutes),
        modules: Array.from(modulesMap.values())
    };
}
