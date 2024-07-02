<!-- Autogenerated by weave; DO NOT EDIT -->

# Flows

Flows are wrapped functions with some additional characteristics over direct
calls: they are strongly typed, streamable, locally and remotely callable, and
fully observable.
Firebase Genkit provides CLI and developer UI tooling for running and debugging flows.

## Defining flows

In its simplest form, a flow just wraps a function:

- {Go}

  ```go
  menuSuggestionFlow := genkit.DefineFlow(
  	"menuSuggestionFlow",
  	func(ctx context.Context, restaurantTheme string) (string, error) {
  		suggestion := makeMenuItemSuggestion(restaurantTheme)
  		return suggestion, nil
  	})
  ```

Doing so lets you run the function from the Genkit CLI and developer UI, and is
a requirement for many of Genkit's features, including deployment and
observability.

An important advantage Genkit flows have over directly calling a model API is
type safety of both inputs and outputs:

- {Go}

  The argument and result types of a flow can be simple or structured values.
  Genkit will produce JSON schemas for these values using
  [`invopop/jsonschema`](https://pkg.go.dev/github.com/invopop/jsonschema).

  The following flow takes a `string` as input and outputs a `struct`:

  ```go
  type MenuSuggestion struct {
  	ItemName    string `json:"item_name"`
  	Description string `json:"description"`
  	Calories    int    `json:"calories"`
  }
  ```

  ```go
  menuSuggestionFlow := genkit.DefineFlow(
  	"menuSuggestionFlow",
  	func(ctx context.Context, restaurantTheme string) (MenuSuggestion, error) {
  		suggestion := makeStructuredMenuItemSuggestion(restaurantTheme)
  		return suggestion, nil
  	},
  )
  ```

## Running flows

To run a flow in your code:

- {Go}

  ```go
  suggestion, err := menuSuggestionFlow.Run(context.Background(), "French")
  ```

You can use the CLI to run flows as well:

```posix-terminal
genkit flow:run menuSuggestionFlow '"French"'
```

### Streamed

Here's a simple example of a flow that can stream values:

- {Go}

  ```go
  // Types for illustrative purposes.
  type InputType string
  type OutputType string
  type StreamType string
  ```

  ```go
  menuSuggestionFlow := genkit.DefineStreamingFlow(
  	"menuSuggestionFlow",
  	func(
  		ctx context.Context,
  		restaurantTheme InputType,
  		callback func(context.Context, StreamType) error,
  	) (OutputType, error) {
  		var menu strings.Builder
  		menuChunks := make(chan StreamType)
  		go makeFullMenuSuggestion(restaurantTheme, menuChunks)
  		for {
  			chunk, ok := <-menuChunks
  			if !ok {
  				break
  			}
  			if callback != nil {
  				callback(context.Background(), chunk)
  			}
  			menu.WriteString(string(chunk))
  		}
  		return OutputType(menu.String()), nil
  	},
  )
  ```

Note that the streaming callback can be undefined. It's only defined if the
invoking client is requesting streamed response.

To invoke a flow in streaming mode:

- {Go}

  ```go
  menuSuggestionFlow.Stream(
  	context.Background(),
  	"French",
  )(func(sfv *core.StreamFlowValue[OutputType, StreamType], err error) bool {
  	if !sfv.Done {
  		fmt.Print(sfv.Output)
  		return true
  	} else {
  		return false
  	}
  })
  ```

  If the flow doesn't implement streaming, `StreamFlow()` behaves identically to
  `RunFlow()`.

You can use the CLI to stream flows as well:

```posix-terminal
genkit flow:run menuSuggestionFlow '"French"' -s
```

## Deploying flows

If you want to be able to access your flow over HTTP you will need to deploy it
first.

- {Go}

  To deploy flows using Cloud Run and similar services, define your flows, and
  then call `Init()`:

  ```go
  func main() {
  	genkit.DefineFlow(
  		"menuSuggestionFlow",
  		func(ctx context.Context, restaurantTheme string) (string, error) {
  			// ...
  			return "", nil
  		},
  	)
  	if err := genkit.Init(context.Background(), nil); err != nil {
  		log.Fatal(err)
  	}
  }
  ```

  `Init` starts a `net/http` server that exposes your flows as HTTP
  endpoints (for example, `http://localhost:3400/menuSuggestionFlow`).

  The second parameter is an optional `Options` that specifies the following:

  - `FlowAddr`: Address and port to listen on. If not specified,
    the server listens on the port specified by the PORT environment variable;
    if that is empty, it uses the default of port 3400.
  - `Flows`: Which flows to serve. If not specified, `Init` serves all of
    your defined flows.

  If you want to serve flows on the same host and port as other endpoints, you
  can set `FlowAddr` to `-` and instead call `NewFlowServeMux()` to get a handler
  for your Genkit flows, which you can multiplex with your other route handlers:

  ```go
  mainMux := http.NewServeMux()
  mainMux.Handle("POST /flow/", http.StripPrefix("/flow/", genkit.NewFlowServeMux(nil)))
  ```

## Flow observability

Sometimes when using 3rd party SDKs that are not instrumented for observability,
you might want to see them as a separate trace step in the Developer UI. All you
need to do is wrap the code in the `run` function.

```go
genkit.DefineFlow(
	"menuSuggestionFlow",
	func(ctx context.Context, restaurantTheme string) (string, error) {
		themes, err := genkit.Run(ctx, "find-similar-themes", func() (string, error) {
			// ...
			return "", nil
		})

		// ...
		return themes, err
	})
```