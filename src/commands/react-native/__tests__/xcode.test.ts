// tslint:disable: no-string-literal
import {Cli} from 'clipanion/lib/advanced'
import {XCodeCommand} from '../xcode'

beforeEach(() => {
  delete process.env.CONFIGURATION
  delete process.env.CONFIGURATION_BUILD_DIR
  delete process.env.CURRENT_PROJECT_VERSION
  delete process.env.DATADOG_API_KEY
  delete process.env.EXTRA_PACKAGER_ARGS
  delete process.env.MARKETING_VERSION
  delete process.env.PRODUCT_BUNDLE_IDENTIFIER
  delete process.env.SERVICE_NAME_IOS
  delete process.env.SOURCEMAP_FILE
})

const makeCli = () => {
  const cli = new Cli()
  cli.register(XCodeCommand)

  return cli
}

const createMockContext = () => {
  let data = ''
  let errorData = ''

  return {
    stderr: {
      toString: () => errorData,
      write: (input: string) => {
        errorData += input
      },
    },
    stdout: {
      toString: () => data,
      write: (input: string) => {
        data += input
      },
    },
  }
}

const basicEnvironment = {
  CONFIGURATION: 'Release',
  CONFIGURATION_BUILD_DIR: './src/commands/react-native/__tests__/fixtures/basic-ios',
  CURRENT_PROJECT_VERSION: '000020',
  MARKETING_VERSION: '0.0.2',
  PRODUCT_BUNDLE_IDENTIFIER: 'com.myapp.test',
  SOURCEMAP_FILE: './src/commands/react-native/__tests__/fixtures/basic-ios/main.jsbundle.map',
}

const runCLI = async (script: string, options?: {force?: boolean; propertiesPath?: string; service?: string}) => {
  const cli = makeCli()
  const context = createMockContext() as any
  if (!options?.propertiesPath) {
    process.env = {...process.env, DATADOG_API_KEY: 'PLACEHOLDER'}
  }

  const command = ['react-native', 'xcode', script, '--dry-run']
  if (options?.force) {
    command.push('--force')
  }
  if (options?.propertiesPath) {
    command.push('--properties-path')
    command.push(options.propertiesPath)
  }
  if (options?.service) {
    command.push('--service')
    command.push(options.service)
  }

  const code = await cli.run(command, context)

  return {context, code}
}

describe('xcode', () => {
  describe('getBundleLocation', () => {
    test('should return the location from CONFIGURATION_BUILD_DIR', () => {
      process.env.CONFIGURATION_BUILD_DIR = './src/commands/react-native/__tests__/fixtures/basic-ios'
      const command = new XCodeCommand()
      expect(command['getBundleLocation']()).toBe(
        './src/commands/react-native/__tests__/fixtures/basic-ios/main.jsbundle'
      )
    })

    test('should return null if no CONFIGURATION_BUILD_DIR is specified', () => {
      const command = new XCodeCommand()
      expect(command['getBundleLocation']()).toBeNull()
    })
  })

  describe('getSourcemapsLocation', () => {
    test('should return the location form SOURCEMAP_FILE', () => {
      process.env.SOURCEMAP_FILE = './main.jsbundle.map'
      const command = new XCodeCommand()
      expect(command['getSourcemapsLocation']()).toMatch('./main.jsbundle.map')
    })

    test('should return the location form EXTRA_PACKAGER_ARGS', () => {
      process.env.EXTRA_PACKAGER_ARGS = '--bundle-output ./main.jsbundle --sourcemap-output ./main.jsbundle.map'
      const command = new XCodeCommand()
      expect(command['getSourcemapsLocation']()).toBe('./main.jsbundle.map')
    })

    test('should return null if no sourcemap specified', () => {
      const command = new XCodeCommand()
      expect(command['getSourcemapsLocation']()).toBeNull()
    })
  })

  describe('execute', () => {
    test('should run the provided script and upload sourcemaps', async () => {
      process.env = {
        ...process.env,
        ...basicEnvironment,
      }
      const {context, code} = await runCLI(
        './src/commands/react-native/__tests__/fixtures/bundle-script/successful_script.sh'
      )
      // Uncomment these lines for debugging failing script
      // console.log(context.stdout.toString())
      // console.log(context.stderr.toString())

      expect(code).toBe(0)
      const output = context.stdout.toString()
      expect(output).toContain(
        'Upload of ./src/commands/react-native/__tests__/fixtures/basic-ios/main.jsbundle.map for bundle ./src/commands/react-native/__tests__/fixtures/basic-ios/main.jsbundle on platform ios'
      )
      expect(output).toContain('version: 0.0.2 build: 000020 service: com.myapp.test')
    })

    test('should not upload sourcemaps when the build configuration is Debug', async () => {
      process.env = {
        ...process.env,
        ...basicEnvironment,
        CONFIGURATION: 'Debug',
      }
      const {context, code} = await runCLI(
        './src/commands/react-native/__tests__/fixtures/bundle-script/successful_script.sh'
      )
      // Uncomment these lines for debugging failing script
      // console.log(context.stdout.toString())
      // console.log(context.stderr.toString())

      expect(code).toBe(0)
      const output = context.stdout.toString()
      expect(output).toContain('Build configuration Debug is not Release, skipping sourcemaps upload')
    })

    test('should run the provided script and upload sourcemaps when the build configuration is Debug with force option', async () => {
      process.env = {
        ...process.env,
        ...basicEnvironment,
        CONFIGURATION: 'Debug',
      }
      const {context, code} = await runCLI(
        './src/commands/react-native/__tests__/fixtures/bundle-script/successful_script.sh',
        {
          force: true,
        }
      )
      // Uncomment these lines for debugging failing script
      // console.log(context.stdout.toString())
      // console.log(context.stderr.toString())

      expect(code).toBe(0)
      const output = context.stdout.toString()
      expect(output).toContain('Force upload for configuration Debug')
      expect(output).toContain(
        'Upload of ./src/commands/react-native/__tests__/fixtures/basic-ios/main.jsbundle.map for bundle ./src/commands/react-native/__tests__/fixtures/basic-ios/main.jsbundle on platform ios'
      )
      expect(output).toContain('version: 0.0.2 build: 000020 service: com.myapp.test')
    })

    test('should run the provided script and upload sourcemaps when a custom service is specified in properties file', async () => {
      process.env = {
        ...process.env,
        ...basicEnvironment,
      }
      const {context, code} = await runCLI(
        './src/commands/react-native/__tests__/fixtures/bundle-script/successful_script.sh',
        {
          propertiesPath:
            './src/commands/react-native/__tests__/fixtures/environment-files/properties-with-service.properties',
        }
      )
      // Uncomment these lines for debugging failing script
      // console.log(context.stdout.toString())
      // console.log(context.stderr.toString())

      expect(code).toBe(0)
      const output = context.stdout.toString()
      expect(output).toContain(
        'Upload of ./src/commands/react-native/__tests__/fixtures/basic-ios/main.jsbundle.map for bundle ./src/commands/react-native/__tests__/fixtures/basic-ios/main.jsbundle on platform ios'
      )
      expect(output).toContain('version: 0.0.2 build: 000020 service: custom.service.from.file')
    })

    test('should run the provided script and upload sourcemaps when a custom service is specified', async () => {
      process.env = {
        ...process.env,
        ...basicEnvironment,
      }
      const {context, code} = await runCLI(
        './src/commands/react-native/__tests__/fixtures/bundle-script/successful_script.sh',
        {
          service: 'com.custom',
        }
      )
      // Uncomment these lines for debugging failing script
      // console.log(context.stdout.toString())
      // console.log(context.stderr.toString())

      expect(code).toBe(0)
      const output = context.stdout.toString()
      expect(output).toContain(
        'Upload of ./src/commands/react-native/__tests__/fixtures/basic-ios/main.jsbundle.map for bundle ./src/commands/react-native/__tests__/fixtures/basic-ios/main.jsbundle on platform ios'
      )
      expect(output).toContain('version: 0.0.2 build: 000020 service: com.custom')
    })

    test('should read the env variables when a properties file is specified', async () => {
      process.env = {
        ...process.env,
        ...basicEnvironment,
      }
      const {context, code} = await runCLI(
        './src/commands/react-native/__tests__/fixtures/bundle-script/successful_script.sh',
        {
          propertiesPath:
            './src/commands/react-native/__tests__/fixtures/environment-files/properties-with-api-key.properties',
        }
      )
      // Uncomment these lines for debugging failing script
      // console.log(context.stdout.toString())
      // console.log(context.stderr.toString())

      expect(code).toBe(0)
      expect(process.env.DATADOG_API_KEY).toBe('api_key_from_file')
      const output = context.stdout.toString()
      expect(output).toContain(
        'Upload of ./src/commands/react-native/__tests__/fixtures/basic-ios/main.jsbundle.map for bundle ./src/commands/react-native/__tests__/fixtures/basic-ios/main.jsbundle on platform ios'
      )
      expect(output).toContain('version: 0.0.2 build: 000020 service: com.myapp.test')
    })

    test.each([['PRODUCT_BUNDLE_IDENTIFIER'], ['CONFIGURATION'], ['MARKETING_VERSION'], ['CURRENT_PROJECT_VERSION']])(
      'should provide a custom message when %s xcode environment variable is missing',
      async (variable) => {
        process.env = {
          ...process.env,
          ...basicEnvironment,
        }
        delete process.env[variable]

        const {context, code} = await runCLI(
          './src/commands/react-native/__tests__/fixtures/bundle-script/successful_script.sh'
        )
        // Uncomment these lines for debugging failing script
        // console.log(context.stdout.toString())
        // console.log(context.stderr.toString())

        expect(code).toBe(1)
        const output = context.stderr.toString()
        expect(output).toContain(`Environment variable ${variable} is missing for Datadog sourcemaps upload.`)
      }
    )

    test('should provide a clear error message when the script path is incorrect', async () => {
      process.env = {
        ...process.env,
        ...basicEnvironment,
      }

      const {context, code} = await runCLI(
        './src/commands/react-native/__tests__/fixtures/bundle-script/non_existent.sh'
      )
      // Uncomment these lines for debugging failing script
      // console.log(context.stdout.toString())
      // console.log(context.stderr.toString())

      expect(code).toBe(1)
      const output = context.stderr.toString()
      expect(output).toContain('Error running bundle script from datadog-ci xcode')
      expect(output).toContain(
        'Error: spawn ./src/commands/react-native/__tests__/fixtures/bundle-script/non_existent.sh ENOENT'
      )
    })

    test('should forward the error message from the script when the script fails', async () => {
      process.env = {
        ...process.env,
        ...basicEnvironment,
      }

      const {context, code} = await runCLI(
        './src/commands/react-native/__tests__/fixtures/bundle-script/failing_script.sh'
      )
      // Uncomment these lines for debugging failing script
      // console.log(context.stdout.toString())
      // console.log(context.stderr.toString())

      expect(code).toBe(1)
      const output = context.stdout.toString()
      expect(output).toContain('[bundle script]: Starting failing script')

      const errorOutput = context.stderr.toString()
      expect(errorOutput).toContain('Error running bundle script from datadog-ci xcode.')
      expect(errorOutput).toContain('[bundle script]: Custom error message from script')
    })

    test('should provide a clear error message when no bundle file is present', async () => {
      process.env = {
        ...process.env,
        ...basicEnvironment,
      }
      delete process.env.CONFIGURATION_BUILD_DIR

      const {context, code} = await runCLI(
        './src/commands/react-native/__tests__/fixtures/bundle-script/successful_script.sh'
      )
      // Uncomment these lines for debugging failing script
      // console.log(context.stdout.toString())
      // console.log(context.stderr.toString())

      expect(code).toBe(1)
      const errorOutput = context.stderr.toString()
      expect(errorOutput).toContain('No bundle file output has been specified')
    })

    test('should provide a clear error message when no sourcemap file is present', async () => {
      process.env = {
        ...process.env,
        ...basicEnvironment,
      }
      delete process.env.SOURCEMAP_FILE

      const {context, code} = await runCLI(
        './src/commands/react-native/__tests__/fixtures/bundle-script/successful_script.sh'
      )
      // Uncomment these lines for debugging failing script
      // console.log(context.stdout.toString())
      // console.log(context.stderr.toString())

      expect(code).toBe(1)
      const errorOutput = context.stderr.toString()
      expect(errorOutput).toContain('No sourcemap output has been specified')
    })

    test('should provide a clear error message when the upload fails', async () => {
      process.env = {
        ...process.env,
        ...basicEnvironment,
        CONFIGURATION_BUILD_DIR: 'src/commands/react-native/__tests__/fixtures/non-existent',
      }

      const {context, code} = await runCLI(
        './src/commands/react-native/__tests__/fixtures/bundle-script/successful_script.sh'
      )
      // Uncomment these lines for debugging failing script
      // console.log(context.stdout.toString())
      // console.log(context.stderr.toString())

      expect(code).not.toBe(0)
      const output = context.stdout.toString()
      expect(output).toContain(
        'Missing bundle file (src/commands/react-native/__tests__/fixtures/non-existent/main.jsbundle)'
      )
    })

    test('should provide a clear error message when the properties file cannot be read', async () => {
      process.env = {
        ...process.env,
        ...basicEnvironment,
      }

      const {context, code} = await runCLI(
        './src/commands/react-native/__tests__/fixtures/bundle-script/successful_script.sh',
        {
          propertiesPath: './src/commands/react-native/__tests__/fixtures/environment-files/non-existent.properties',
        }
      )
      // Uncomment these lines for debugging failing script
      // console.log(context.stdout.toString())
      // console.log(context.stderr.toString())

      expect(code).not.toBe(0)
      const output = context.stderr.toString()
      expect(output).toContain('Environment variable DATADOG_API_KEY is missing for Datadog sourcemaps upload.')
      expect(output).toContain('There was an issue reading the datadog.properties file')
    })

    test('should provide a clear error message when the properties file is missing the DATADOG_API_KEY', async () => {
      process.env = {
        ...process.env,
        ...basicEnvironment,
      }

      const {context, code} = await runCLI(
        './src/commands/react-native/__tests__/fixtures/bundle-script/successful_script.sh',
        {
          propertiesPath: './src/commands/react-native/__tests__/fixtures/environment-files/empty.properties',
        }
      )
      // Uncomment these lines for debugging failing script
      // console.log(context.stdout.toString())
      // console.log(context.stderr.toString())

      expect(code).not.toBe(0)
      const output = context.stderr.toString()
      expect(output).toContain('Environment variable DATADOG_API_KEY is missing for Datadog sourcemaps upload.')
      expect(output).toContain('The datadog.properties file exist but it appears to be missing from it.')
    })
  })
})
