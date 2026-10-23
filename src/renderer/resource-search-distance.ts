export function boundedNameDistance(left: string, right: string, limit: number): number {
  if (left.length > 64 || right.length > 64 || Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let beforePrevious = previous;
  for (let row = 1; row <= left.length; row++) {
    const current = Array<number>(right.length + 1).fill(limit + 1);
    current[0] = row;
    let minimum = limit + 1;
    for (let column = Math.max(1, row - limit); column <= Math.min(right.length, row + limit); column++) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1])
        current[column] = Math.min(current[column], beforePrevious[column - 2] + 1);
      minimum = Math.min(minimum, current[column]);
    }
    if (minimum > limit) return limit + 1;
    beforePrevious = previous;
    previous = current;
  }
  return previous[right.length];
}
