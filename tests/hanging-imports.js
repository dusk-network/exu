export default {};

// Never finishes: an instance using these imports never starts.
export const oninit = () => new Promise(() => {});
