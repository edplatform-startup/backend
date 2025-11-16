let customCourseBuilder = null;

export function setCourseBuilder(fn) {
  customCourseBuilder = typeof fn === 'function' ? fn : null;
}

export function clearCourseBuilder() {
  customCourseBuilder = null;
}

export function buildAssetPlanFromCourse(course) {
  throw new Error('Course generation is not implemented');
}

export async function generateCoursePackageWithAssets(options = {}) {
  if (customCourseBuilder) {
    return await customCourseBuilder(options);
  }

  throw new Error('Course generation is not implemented');
}

