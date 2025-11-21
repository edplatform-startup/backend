import { getSupabase } from '../supabaseClient.js';

/**
 * Checks if a lesson (node) is locked based on its prerequisites.
 * A lesson is locked only if any of its parent nodes are in "pending" status.
 * If all parents are "mastered" or "needs_review", the lesson is unlocked.
 * 
 * @param {string} nodeId - The ID of the node to check
 * @param {string} courseId - The ID of the course
 * @param {string} userId - The ID of the user
 * @returns {Promise<{isLocked: boolean, prerequisites: Array}>} Lock status and prerequisite details
 */
export async function checkNodeLockStatus(nodeId, courseId, userId) {
    const supabase = getSupabase();

    // Fetch all parent dependencies for this node
    const { data: dependencies, error: depsError } = await supabase
        .schema('api')
        .from('node_dependencies')
        .select('parent_id')
        .eq('course_id', courseId)
        .eq('child_id', nodeId);

    if (depsError) {
        throw new Error(`Failed to fetch dependencies: ${depsError.message}`);
    }

    // If no prerequisites, node is unlocked
    if (!dependencies || dependencies.length === 0) {
        return { isLocked: false, prerequisites: [] };
    }

    const parentIds = dependencies.map(dep => dep.parent_id);

    // Fetch user state for all parent nodes
    const { data: parentStates, error: stateError } = await supabase
        .schema('api')
        .from('user_node_state')
        .select('node_id, mastery_status')
        .eq('user_id', userId)
        .in('node_id', parentIds);

    if (stateError) {
        throw new Error(`Failed to fetch parent states: ${stateError.message}`);
    }

    // Create a map of parent statuses
    const statusMap = new Map();
    (parentStates || []).forEach(state => {
        statusMap.set(state.node_id, state.mastery_status);
    });

    // Check if any parent is in "pending" state
    const prerequisites = parentIds.map(parentId => {
        const status = statusMap.get(parentId) || 'pending'; // Default to pending if no state exists
        return {
            node_id: parentId,
            status: status
        };
    });

    // Node is locked if ANY parent is in "pending" state
    const isLocked = prerequisites.some(prereq => prereq.status === 'pending');

    return { isLocked, prerequisites };
}

/**
 * Calculates lock status for multiple nodes efficiently.
 * 
 * @param {Array<string>} nodeIds - Array of node IDs
 * @param {string} courseId - The ID of the course
 * @param {string} userId - The ID of the user
 * @returns {Promise<Map<string, boolean>>} Map of nodeId to isLocked status
 */
export async function checkMultipleNodesLockStatus(nodeIds, courseId, userId) {
    if (!nodeIds || nodeIds.length === 0) {
        return new Map();
    }

    const supabase = getSupabase();

    // Fetch all dependencies for these nodes
    const { data: dependencies, error: depsError } = await supabase
        .schema('api')
        .from('node_dependencies')
        .select('parent_id, child_id')
        .eq('course_id', courseId)
        .in('child_id', nodeIds);

    if (depsError) {
        throw new Error(`Failed to fetch dependencies: ${depsError.message}`);
    }

    // Build a map of node -> parent IDs
    const nodeParentsMap = new Map();
    (dependencies || []).forEach(dep => {
        if (!nodeParentsMap.has(dep.child_id)) {
            nodeParentsMap.set(dep.child_id, []);
        }
        nodeParentsMap.get(dep.child_id).push(dep.parent_id);
    });

    // Get all unique parent IDs
    const allParentIds = [...new Set(dependencies?.map(d => d.parent_id) || [])];

    if (allParentIds.length === 0) {
        // No dependencies, all nodes are unlocked
        const lockMap = new Map();
        nodeIds.forEach(nodeId => lockMap.set(nodeId, false));
        return lockMap;
    }

    // Fetch user state for all parent nodes
    const { data: parentStates, error: stateError } = await supabase
        .schema('api')
        .from('user_node_state')
        .select('node_id, mastery_status')
        .eq('user_id', userId)
        .in('node_id', allParentIds);

    if (stateError) {
        throw new Error(`Failed to fetch parent states: ${stateError.message}`);
    }

    // Create a map of parent statuses
    const statusMap = new Map();
    (parentStates || []).forEach(state => {
        statusMap.set(state.node_id, state.mastery_status);
    });

    // Calculate lock status for each node
    const lockStatusMap = new Map();
    nodeIds.forEach(nodeId => {
        const parents = nodeParentsMap.get(nodeId) || [];

        if (parents.length === 0) {
            // No prerequisites, unlocked
            lockStatusMap.set(nodeId, false);
        } else {
            // Check if any parent is in "pending" state
            const hasLockedParent = parents.some(parentId => {
                const status = statusMap.get(parentId) || 'pending';
                return status === 'pending';
            });
            lockStatusMap.set(nodeId, hasLockedParent);
        }
    });

    return lockStatusMap;
}
