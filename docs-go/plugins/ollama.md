<!-- Autogenerated by weave; DO NOT EDIT -->

# Ollama plugin

The Ollama plugin provides interfaces to any of the local LLMs supported by
[Ollama](https://ollama.com/).

## Prerequisites

This plugin requires that you first install and run the Ollama server. You can
follow the instructions on the [Download Ollama](https://ollama.com/download)
page.

Use the Ollama CLI to download the models you are interested in. For example:

```posix-terminal
ollama pull gemma2
```

For development, you can run Ollama on your development machine. Deployed apps
usually run Ollama on a different, GPU-accelerated, machine from the app backend
that runs Genkit.

## Configuration

To use this plugin, call `ollama.Init()`, specifying the address of your Ollama
server:

```go
import "github.com/firebase/genkit/go/plugins/ollama"
```

```go
// Init with Ollama's default local address.
if err := ollama.Init(ctx, "http://127.0.0.1:11434"); err != nil {
	return err
}
```

## Usage

To generate content, you first need to create a model definition based on the
model you installed and want to use. For example, if you installed Gemma 2:

```go
model := ollama.DefineModel(
	ollama.ModelDefinition{
		Name: "gemma2",
		Type: "chat", // "chat" or "generate"
	},
	&ai.ModelCapabilities{
		Multiturn:  true,
		SystemRole: true,
		Tools:      false,
		Media:      false,
	},
)
```

Then, you can use the model reference to send requests to your Ollama server:

```go
genRes, err := model.Generate(ctx, ai.NewGenerateRequest(
	nil, ai.NewUserTextMessage("Tell me a joke.")), nil)
if err != nil {
	return err
}
```

See [Generating content](models.md) for more information.