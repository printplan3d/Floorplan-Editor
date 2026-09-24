export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (e) {
    if (specifier.startsWith('.') && !specifier.endsWith('.js')) {
      try { return await next(specifier + '.js', context) } catch { return next(specifier + '/index.js', context) }
    }
    throw e
  }
}
