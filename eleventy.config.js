export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ "src/site/assets": "assets" });
  eleventyConfig.addPassthroughCopy({ "src/site/robots.txt": "robots.txt" });

  eleventyConfig.addFilter("readableDate", (value) => {
    const date = new Date(value);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  });

  // ISO date filter for sitemap
  eleventyConfig.addFilter("isoDate", (value) => {
    const date = new Date(value);
    return date.toISOString().split('T')[0];
  });

  return {
    dir: {
      input: "src/site",
      includes: "_includes",
      output: "_site",
    },
  };
}
