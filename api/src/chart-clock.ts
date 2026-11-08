export function createChartClock() {
  let wallAnchor: number | null = null;
  let performanceAnchor = 0;
  return {
    sample(wallTime: number, performanceTime: number): number {
      if (
        wallAnchor === null ||
        Math.abs(wallAnchor + performanceTime - performanceAnchor - wallTime) >
          1000
      ) {
        wallAnchor = wallTime;
        performanceAnchor = performanceTime;
      }
      return wallAnchor + performanceTime - performanceAnchor;
    },
    reset() {
      wallAnchor = null;
    },
  };
}
