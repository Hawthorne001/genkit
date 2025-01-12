// Copyright 2024 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package snippets

import (
	"context"
	"errors"
	"fmt"

	"github.com/firebase/genkit/go/ai"
	"github.com/invopop/jsonschema"
)

func pr01() {
	model := ai.Model{}

	// [START pr01]
	request := ai.GenerateRequest{Messages: []*ai.Message{
		{Content: []*ai.Part{ai.NewTextPart("You are a helpful AI assistant named Walt.")}},
	}}
	model.Generate(context.Background(), &request, nil)
	// [END pr01]
}

// [START hello]
func helloPrompt(name string) *ai.Part {
	prompt := fmt.Sprintf("You are a helpful AI assistant named Walt. Say hello to %s.", name)
	return ai.NewTextPart(prompt)
}

// [END hello]

func pr02() {
	model := ai.Model{}

	// [START pr02]
	request := ai.GenerateRequest{Messages: []*ai.Message{
		{Content: []*ai.Part{helloPrompt("Fred")}},
	}}
	response, err := model.Generate(context.Background(), &request, nil)
	// [END pr02]

	if err == nil {
		_ = response
	}
}

func pr03() error {
	model := ai.Model{}

	// [START pr03_1]
	type HelloPromptInput struct {
		UserName string
	}
	helloPrompt := ai.DefinePrompt(
		"prompts",
		"helloPrompt",
		nil, // Additional model config
		jsonschema.Reflect(&HelloPromptInput{}),
		func(ctx context.Context, input any) (*ai.GenerateRequest, error) {
			params, ok := input.(HelloPromptInput)
			if !ok {
				return nil, errors.New("input doesn't satisfy schema")
			}
			prompt := fmt.Sprintf(
				"You are a helpful AI assistant named Walt. Say hello to %s.",
				params.UserName)
			return &ai.GenerateRequest{Messages: []*ai.Message{
				{Content: []*ai.Part{ai.NewTextPart(prompt)}},
			}}, nil
		},
	)
	// [END pr03_1]

	// [START pr03_2]
	request, err := helloPrompt.Render(context.Background(), HelloPromptInput{UserName: "Fred"})
	if err != nil {
		return err
	}
	response, err := model.Generate(context.Background(), request, nil)
	// [END pr03_2]

	_ = response
	_ = err
	return nil
}
