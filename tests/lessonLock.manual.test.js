/**
 * Manual test for lesson unlocking based on prerequisites
 * 
 * This script demonstrates how lessons are unlocked based on prerequisite completion:
 * - A lesson is LOCKED if ANY of its prerequisites are in "pending" state
 * - A lesson is UNLOCKED if ALL prerequisites are either "mastered" or "needs_review"
 * 
 * To run this test:
 * node tests/lessonLock.manual.test.js
 */

import { checkNodeLockStatus, checkMultipleNodesLockStatus } from '../src/services/lessonLock.js';

// Test configuration
const TEST_CONFIG = {
    courseId: 'YOUR_COURSE_ID_HERE',
    userId: 'YOUR_USER_ID_HERE',
    nodeId: 'YOUR_NODE_ID_HERE',
};

async function testSingleNodeLockStatus() {
    console.log('\n🔒 Testing Single Node Lock Status\n');
    console.log('Config:', TEST_CONFIG);

    try {
        const result = await checkNodeLockStatus(
            TEST_CONFIG.nodeId,
            TEST_CONFIG.courseId,
            TEST_CONFIG.userId
        );

        console.log('\n✅ Lock Status Result:');
        console.log(JSON.stringify(result, null, 2));

        if (result.isLocked) {
            console.log('\n🔒 This lesson is LOCKED');
            console.log('Reason: One or more prerequisites are in "pending" state');
            console.log('\nPrerequisites that need completion:');
            result.prerequisites
                .filter(p => p.status === 'pending')
                .forEach(p => {
                    console.log(`  - Node ${p.node_id}: ${p.status}`);
                });
        } else {
            console.log('\n🔓 This lesson is UNLOCKED');
            if (result.prerequisites.length === 0) {
                console.log('Reason: No prerequisites required');
            } else {
                console.log('Reason: All prerequisites are completed (mastered or needs_review)');
                console.log('\nCompleted prerequisites:');
                result.prerequisites.forEach(p => {
                    console.log(`  - Node ${p.node_id}: ${p.status}`);
                });
            }
        }
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

async function testMultipleNodesLockStatus() {
    console.log('\n🔒 Testing Multiple Nodes Lock Status\n');

    // You can test multiple nodes at once
    const nodeIds = [
        TEST_CONFIG.nodeId,
        // Add more node IDs here
    ];

    try {
        const lockMap = await checkMultipleNodesLockStatus(
            nodeIds,
            TEST_CONFIG.courseId,
            TEST_CONFIG.userId
        );

        console.log('\n✅ Lock Status for Multiple Nodes:');
        for (const [nodeId, isLocked] of lockMap.entries()) {
            console.log(`  ${nodeId}: ${isLocked ? '🔒 LOCKED' : '🔓 UNLOCKED'}`);
        }
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

async function demonstrateUnlockingFlow() {
    console.log('\n📚 Demonstration: How Lesson Unlocking Works\n');
    console.log('Scenario:');
    console.log('  Node A (Intro) → Node B (Intermediate) → Node C (Advanced)');
    console.log('');
    console.log('Initial State:');
    console.log('  - Node A: pending');
    console.log('  - Node B: pending (LOCKED because A is pending)');
    console.log('  - Node C: pending (LOCKED because B is pending)');
    console.log('');
    console.log('After completing Node A (status changed to "mastered"):');
    console.log('  - Node A: mastered ✅');
    console.log('  - Node B: pending (UNLOCKED because A is mastered)');
    console.log('  - Node C: pending (LOCKED because B is still pending)');
    console.log('');
    console.log('After marking Node B as "needs_review":');
    console.log('  - Node A: mastered ✅');
    console.log('  - Node B: needs_review ⚠️');
    console.log('  - Node C: pending (UNLOCKED because B is not pending anymore)');
    console.log('');
    console.log('Key Points:');
    console.log('  ✓ Lessons unlock when prerequisites are NOT in "pending" state');
    console.log('  ✓ Both "mastered" and "needs_review" statuses unlock next lessons');
    console.log('  ✓ Only "pending" prerequisites keep lessons locked');
}

// Run tests
async function runTests() {
    console.log('='.repeat(60));
    console.log('Lesson Unlocking System - Manual Test');
    console.log('='.repeat(60));

    // Show demonstration first
    await demonstrateUnlockingFlow();

    console.log('\n\n' + '='.repeat(60));
    console.log('UPDATE THE TEST_CONFIG ABOVE TO RUN ACTUAL TESTS');
    console.log('='.repeat(60));

    // Uncomment to run actual tests (after updating TEST_CONFIG)
    // await testSingleNodeLockStatus();
    // await testMultipleNodesLockStatus();
}

runTests().catch(console.error);
