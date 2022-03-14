import * as fs from 'fs'
import * as path from 'path'
import {URL} from 'url'
import {promisify} from 'util'

import chalk from 'chalk'
import glob from 'glob'

import {getCIMetadata} from '../../helpers/ci'
import {pick} from '../../helpers/utils'

import {EndpointError, formatBackendErrors, is5xxError, isForbiddenError, isNotFoundError} from './api'
import {
  APIHelper,
  ConfigOverride,
  ERRORS,
  ExecutionRule,
  InternalTest,
  MainReporter,
  Payload,
  PollResult,
  Reporter,
  Result,
  Suite,
  Summary,
  SyntheticsMetadata,
  TemplateContext,
  TemplateVariables,
  TestPayload,
  Trigger,
  TriggerConfig,
  TriggerResponse,
  TriggerResult,
} from './interfaces'
import {Tunnel} from './tunnel'

const POLLING_INTERVAL = 5000 // In ms
const PUBLIC_ID_REGEX = /^[\d\w]{3}-[\d\w]{3}-[\d\w]{3}$/
const SUBDOMAIN_REGEX = /(.*?)\.(?=[^\/]*\..{2,5})/
const TEMPLATE_REGEX = /{{\s*([^{}]*?)\s*}}/g

const template = (st: string, context: any): string =>
  st.replace(TEMPLATE_REGEX, (match: string, p1: string) => (p1 in context ? context[p1] : match))

let ciTriggerApp = 'npm_package'

export const handleConfig = (
  test: InternalTest,
  publicId: string,
  reporter: MainReporter,
  config?: ConfigOverride
): TestPayload => {
  const executionRule = getExecutionRule(test, config)
  let handledConfig: TestPayload = {
    executionRule,
    public_id: publicId,
  }

  if (!config || !Object.keys(config).length) {
    return handledConfig
  }

  handledConfig = {
    ...handledConfig,
    ...pick(config, [
      'allowInsecureCertificates',
      'basicAuth',
      'body',
      'bodyType',
      'cookies',
      'defaultStepTimeout',
      'deviceIds',
      'followRedirects',
      'headers',
      'locations',
      'pollingTimeout',
      'retry',
      'startUrlSubstitutionRegex',
      'tunnel',
      'variables',
    ]),
  }

  if ((test.type === 'browser' || test.subtype === 'http') && config.startUrl) {
    const context = parseUrlVariables(test.config.request.url, reporter)
    if (URL_VARIABLES.some((v) => config.startUrl?.includes(v))) {
      reporter.error('[DEPRECATION] The usage of URL variables is deprecated, see explanation in the README\n\n')
    }
    handledConfig.startUrl = template(config.startUrl, context)
  }

  return handledConfig
}

export const setCiTriggerApp = (source: string): void => {
  ciTriggerApp = source
}

const parseUrlVariables = (url: string, reporter: MainReporter) => {
  const context: TemplateContext = {
    ...process.env,
    URL: url,
  }
  let objUrl
  try {
    objUrl = new URL(url)
  } catch {
    reporter.error(`The start url ${url} contains variables, CI overrides will be ignored\n`)

    return context
  }

  warnOnReservedEnvVarNames(context, reporter)

  const subdomainMatch = objUrl.hostname.match(SUBDOMAIN_REGEX)
  const domain = subdomainMatch ? objUrl.hostname.replace(`${subdomainMatch[1]}.`, '') : objUrl.hostname

  context.DOMAIN = domain
  context.HASH = objUrl.hash
  context.HOST = objUrl.host
  context.HOSTNAME = objUrl.hostname
  context.ORIGIN = objUrl.origin
  context.PARAMS = objUrl.search
  context.PATHNAME = objUrl.pathname
  context.PORT = objUrl.port
  context.PROTOCOL = objUrl.protocol
  context.SUBDOMAIN = subdomainMatch ? subdomainMatch[1] : undefined

  return context
}

const URL_VARIABLES = [
  'DOMAIN',
  'HASH',
  'HOST',
  'HOSTNAME',
  'ORIGIN',
  'PARAMS',
  'PATHNAME',
  'PORT',
  'PROTOCOL',
  'SUBDOMAIN',
] as const

const warnOnReservedEnvVarNames = (context: TemplateContext, reporter: MainReporter) => {
  const reservedVarNames: Set<keyof TemplateVariables> = new Set(URL_VARIABLES)

  const usedEnvVarNames = Object.keys(context).filter((name) => (reservedVarNames as Set<string>).has(name))
  if (usedEnvVarNames.length > 0) {
    const names = usedEnvVarNames.join(', ')
    const plural = usedEnvVarNames.length > 1
    reporter.log(
      `Detected ${names} environment variable${plural ? 's' : ''}. ${names} ${plural ? 'are' : 'is a'} Datadog ` +
        `reserved variable${plural ? 's' : ''} used to parse your original test URL, read more about it on ` +
        'our documentation https://docs.datadoghq.com/synthetics/ci/?tab=apitest#start-url. ' +
        'If you want to override your startUrl parameter using environment variables, ' +
        `use ${plural ? '' : 'a '}different namespace${plural ? 's' : ''}.\n\n`
    )
  }
}

export const getExecutionRule = (test: InternalTest, configOverride?: ConfigOverride): ExecutionRule => {
  if (configOverride && configOverride.executionRule) {
    return getStrictestExecutionRule(configOverride.executionRule, test.options?.ci?.executionRule)
  }

  return test.options?.ci?.executionRule || ExecutionRule.BLOCKING
}

export const getStrictestExecutionRule = (configRule: ExecutionRule, testRule?: ExecutionRule): ExecutionRule => {
  if (configRule === ExecutionRule.SKIPPED || testRule === ExecutionRule.SKIPPED) {
    return ExecutionRule.SKIPPED
  }

  if (configRule === ExecutionRule.NON_BLOCKING || testRule === ExecutionRule.NON_BLOCKING) {
    return ExecutionRule.NON_BLOCKING
  }

  if (configRule === ExecutionRule.BLOCKING || testRule === ExecutionRule.BLOCKING) {
    return ExecutionRule.BLOCKING
  }

  return ExecutionRule.BLOCKING
}

export const isCriticalError = (result: Result): boolean => result.unhealthy || result.error === ERRORS.ENDPOINT

export const hasResultPassed = (result: Result, failOnCriticalErrors: boolean, failOnTimeout: boolean): boolean => {
  if (isCriticalError(result) && !failOnCriticalErrors) {
    return true
  }

  if (result.error === ERRORS.TIMEOUT && !failOnTimeout) {
    return true
  }

  if (typeof result.passed !== 'undefined') {
    return result.passed
  }

  if (typeof result.errorCode !== 'undefined') {
    return false
  }

  return true
}

export const hasTestSucceeded = (
  results: PollResult[],
  failOnCriticalErrors: boolean,
  failOnTimeout: boolean
): boolean =>
  results.every((pollResult: PollResult) => hasResultPassed(pollResult.result, failOnCriticalErrors, failOnTimeout))

export const getSuites = async (GLOB: string, reporter: MainReporter): Promise<Suite[]> => {
  reporter.log(`Finding files in ${path.join(process.cwd(), GLOB)}\n`)
  const files: string[] = await promisify(glob)(GLOB)
  if (files.length) {
    reporter.log(`\nGot test files:\n${files.map((file) => `  - ${file}\n`).join('')}\n`)
  } else {
    reporter.log('\nNo test files found.\n\n')
  }

  return Promise.all(
    files.map(async (file) => {
      try {
        const content = await promisify(fs.readFile)(file, 'utf8')

        return {name: file, content: JSON.parse(content)}
      } catch (e) {
        throw new Error(`Unable to read and parse the test file ${file}`)
      }
    })
  )
}

export const wait = async (duration: number) => new Promise((resolve) => setTimeout(resolve, duration))

export const waitForResults = async (
  api: APIHelper,
  triggerResponses: TriggerResponse[],
  defaultTimeout: number,
  triggerConfigs: TriggerConfig[],
  tunnel?: Tunnel,
  failOnCriticalErrors?: boolean
) => {
  const triggerResultMap = createTriggerResultMap(triggerResponses, defaultTimeout, triggerConfigs)
  const triggerResults = [...triggerResultMap.values()]

  const maxPollingTimeout = Math.max(...triggerResults.map((tr) => tr.pollingTimeout))
  const pollingStartDate = new Date().getTime()

  let isTunnelConnected = true
  if (tunnel) {
    tunnel
      .keepAlive()
      .then(() => (isTunnelConnected = false))
      .catch(() => (isTunnelConnected = false))
  }

  while (triggerResults.filter((tr) => !tr.result).length) {
    const pollingDuration = new Date().getTime() - pollingStartDate

    // Remove test which exceeded their pollingTimeout
    for (const triggerResult of triggerResults.filter((tr) => !tr.result)) {
      if (pollingDuration >= triggerResult.pollingTimeout) {
        triggerResult.result = createFailingResult(
          ERRORS.TIMEOUT,
          triggerResult.result_id,
          triggerResult.device,
          triggerResult.location,
          !!tunnel
        )
      }
    }

    if (tunnel && !isTunnelConnected) {
      for (const triggerResult of triggerResults.filter((tr) => !tr.result)) {
        triggerResult.result = createFailingResult(
          ERRORS.TUNNEL,
          triggerResult.result_id,
          triggerResult.device,
          triggerResult.location,
          !!tunnel
        )
      }
    }

    if (pollingDuration >= maxPollingTimeout) {
      break
    }

    let polledResults: PollResult[]
    const triggerResultsSucceed = triggerResults.filter((tr) => !tr.result)
    try {
      polledResults = (await api.pollResults(triggerResultsSucceed.map((tr) => tr.result_id))).results
    } catch (error) {
      if (is5xxError(error) && !failOnCriticalErrors) {
        polledResults = []
        for (const triggerResult of triggerResultsSucceed) {
          triggerResult.result = createFailingResult(
            ERRORS.ENDPOINT,
            triggerResult.result_id,
            triggerResult.device,
            triggerResult.location,
            !!tunnel
          )
        }
      } else {
        throw error
      }
    }

    for (const polledResult of polledResults) {
      if (polledResult.result.eventType === 'finished') {
        const triggeredResult = triggerResultMap.get(polledResult.resultID)
        if (triggeredResult) {
          triggeredResult.result = polledResult
        }
      }
    }

    if (!triggerResults.filter((tr) => !tr.result).length) {
      break
    }

    await wait(POLLING_INTERVAL)
  }

  // Bundle results by public id
  return triggerResults.reduce((resultsByPublicId, triggerResult) => {
    const result = triggerResult.result! // The result exists, as either polled or filled with a timeout result
    resultsByPublicId[triggerResult.public_id] = [...(resultsByPublicId[triggerResult.public_id] || []), result]

    return resultsByPublicId
  }, {} as {[key: string]: PollResult[]})
}

export const createTriggerResultMap = (
  triggerResponses: TriggerResponse[],
  defaultTimeout: number,
  triggerConfigs: TriggerConfig[]
): Map<string, TriggerResult> => {
  const timeoutByPublicId: {[key: string]: number} = {}
  for (const trigger of triggerConfigs) {
    timeoutByPublicId[trigger.id] = trigger.config.pollingTimeout ?? defaultTimeout
  }

  const triggerResultMap = new Map()
  for (const triggerResponse of triggerResponses) {
    triggerResultMap.set(triggerResponse.result_id, {
      ...triggerResponse,
      pollingTimeout: timeoutByPublicId[triggerResponse.public_id] ?? defaultTimeout,
    })
  }

  return triggerResultMap
}

const createFailingResult = (
  errorMessage: ERRORS,
  resultId: string,
  deviceId: string,
  dcId: number,
  tunnel: boolean
): PollResult => ({
  dc_id: dcId,
  result: {
    device: {height: 0, id: deviceId, width: 0},
    duration: 0,
    error: errorMessage,
    eventType: 'finished',
    passed: false,
    startUrl: '',
    stepDetails: [],
    tunnel,
  },
  resultID: resultId,
  timestamp: 0,
})

export const createSummary = (): Summary => ({
  criticalErrors: 0,
  failed: 0,
  passed: 0,
  skipped: 0,
  testsNotFound: new Set(),
  timedOut: 0,
})

export const getResultDuration = (result: Result): number => {
  if ('duration' in result) {
    return Math.round(result.duration)
  }
  if ('timings' in result) {
    return Math.round(result.timings.total)
  }

  return 0
}

export const getReporter = (reporters: Reporter[]): MainReporter => ({
  error: (error) => {
    for (const reporter of reporters) {
      if (typeof reporter.error === 'function') {
        reporter.error(error)
      }
    }
  },
  initErrors: (errors) => {
    for (const reporter of reporters) {
      if (typeof reporter.initErrors === 'function') {
        reporter.initErrors(errors)
      }
    }
  },
  log: (log) => {
    for (const reporter of reporters) {
      if (typeof reporter.log === 'function') {
        reporter.log(log)
      }
    }
  },
  reportStart: (timings) => {
    for (const reporter of reporters) {
      if (typeof reporter.reportStart === 'function') {
        reporter.reportStart(timings)
      }
    }
  },
  runEnd: (summary) => {
    for (const reporter of reporters) {
      if (typeof reporter.runEnd === 'function') {
        reporter.runEnd(summary)
      }
    }
  },
  testEnd: (test, results, baseUrl, locationNames, failOnCriticalErrors, failOnTimeout) => {
    for (const reporter of reporters) {
      if (typeof reporter.testEnd === 'function') {
        reporter.testEnd(test, results, baseUrl, locationNames, failOnCriticalErrors, failOnTimeout)
      }
    }
  },
  testTrigger: (test, testId, executionRule, config) => {
    for (const reporter of reporters) {
      if (typeof reporter.testTrigger === 'function') {
        reporter.testTrigger(test, testId, executionRule, config)
      }
    }
  },
  testWait: (test) => {
    for (const reporter of reporters) {
      if (typeof reporter.testWait === 'function') {
        reporter.testWait(test)
      }
    }
  },
  testsWait: (tests) => {
    for (const reporter of reporters) {
      if (typeof reporter.testsWait === 'function') {
        reporter.testsWait(tests)
      }
    }
  },
})

export const getTestsToTrigger = async (api: APIHelper, triggerConfigs: TriggerConfig[], reporter: MainReporter) => {
  const overriddenTestsToTrigger: TestPayload[] = []
  const errorMessages: string[] = []
  const summary = createSummary()

  const tests = await Promise.all(
    triggerConfigs.map(async ({config, id, suite}) => {
      let test: InternalTest | undefined
      id = PUBLIC_ID_REGEX.test(id) ? id : id.substr(id.lastIndexOf('/') + 1)
      try {
        test = {
          ...(await api.getTest(id)),
          suite,
        }
      } catch (error) {
        if (error instanceof Error && isNotFoundError(error)) {
          summary.testsNotFound.add(id)
          const errorMessage = formatBackendErrors(error)
          errorMessages.push(`[${chalk.bold.dim(id)}] ${chalk.yellow.bold('Test not found')}: ${errorMessage}`)

          return
        }

        throw error
      }

      const overriddenConfig = handleConfig(test, id, reporter, config)
      overriddenTestsToTrigger.push(overriddenConfig)

      reporter.testTrigger(test, id, overriddenConfig.executionRule, config)
      if (overriddenConfig.executionRule === ExecutionRule.SKIPPED) {
        summary.skipped++
      } else {
        reporter.testWait(test)

        return test
      }
    })
  )

  // Display errors at the end of all tests for better visibility.
  reporter.initErrors(errorMessages)

  if (!overriddenTestsToTrigger.length) {
    throw new Error('No tests to trigger')
  }

  const waitedTests = tests.filter(definedTypeGuard)
  reporter.testsWait(waitedTests)

  return {tests: waitedTests, overriddenTestsToTrigger, summary}
}

export const runTests = async (api: APIHelper, testsToTrigger: TestPayload[]): Promise<Trigger> => {
  const payload: Payload = {tests: testsToTrigger}
  const ciMetadata = getCIMetadata()

  const syntheticsMetadata: SyntheticsMetadata = {
    ci: {job: {}, pipeline: {}, provider: {}, stage: {}},
    git: {commit: {author: {}, committer: {}}},
    ...ciMetadata,
    trigger_app: ciTriggerApp,
  }
  payload.metadata = syntheticsMetadata

  try {
    return await api.triggerTests(payload)
  } catch (e) {
    const errorMessage = formatBackendErrors(e)
    const testIds = testsToTrigger.map((t) => t.public_id).join(',')
    // Rewrite error message
    throw new EndpointError(`[${testIds}] Failed to trigger tests: ${errorMessage}\n`, e.response.status)
  }
}

const definedTypeGuard = <T>(o: T | undefined): o is T => !!o

export const retry = async <T, E extends Error>(
  func: () => Promise<T>,
  shouldRetryAfterWait: (retries: number, error: E) => number | undefined
): Promise<T> => {
  const trier = async (retries = 0): Promise<T> => {
    try {
      return await func()
    } catch (e) {
      const waiter = shouldRetryAfterWait(retries, e)
      if (waiter) {
        await wait(waiter)

        return trier(retries + 1)
      }
      throw e
    }
  }

  return trier()
}

export const parseVariablesFromCli = (
  variableArguments: string[] = [],
  logFunction: (log: string) => void
): {[key: string]: string} | undefined => {
  const variables: {[key: string]: string} = {}

  for (const variableArgument of variableArguments) {
    const separatorIndex = variableArgument.indexOf('=')

    if (separatorIndex === -1) {
      logFunction(`Ignoring variable "${variableArgument}" as separator "=" was not found`)
      continue
    }

    if (separatorIndex === 0) {
      logFunction(`Ignoring variable "${variableArgument}" as variable name is empty`)
      continue
    }

    const key = variableArgument.substring(0, separatorIndex)
    const value = variableArgument.substring(separatorIndex + 1)

    variables[key] = value
  }

  return Object.keys(variables).length > 0 ? variables : undefined
}
