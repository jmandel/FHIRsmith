// @ts-check

//
// Closure Worker - Handles ConceptMap $closure operation
//
// GET /ConceptMap/$closure?{params}
// POST /ConceptMap/$closure
//

class ClosureWorker {
  /**
   * @param {any} _opContext
   * @param {{debug?: (...args: any[]) => void}} [log]
   */
  constructor(_opContext = null, log = console) {
    void _opContext;
    this.log = log;
  }

  /**
   * Handle a $closure request
   * @param {{method: string, body?: any, query?: any}} req - Express request (with txProvider attached)
   * @param {{status: (code: number) => {json: (body: any) => any}}} res - Express response
   * @param {{debug?: (...args: any[]) => void}} [log] - Logger instance
   */
  async handle(req, res, log = this.log) {
    const params = req.method === 'POST' ? req.body : req.query;

    log.debug?.('ConceptMap $closure with params:', params);

    // TODO: Implement closure logic using provider
    res.status(501).json({
      resourceType: 'OperationOutcome',
      issue: [{
        severity: 'error',
        code: 'not-supported',
        diagnostics: 'ConceptMap $closure operation not yet implemented'
      }]
    });
  }
}

module.exports = ClosureWorker;
